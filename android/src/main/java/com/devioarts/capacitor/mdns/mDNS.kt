package com.devioarts.capacitor.mdns
// English-only code and comments.

import android.content.Context
import android.net.nsd.NsdManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Thin Android NSD (Bonjour/mDNS) wrapper used by the Capacitor bridge.
 *
 * Responsibilities:
 * - Register/unregister (advertise/stop) a single service.
 * - Discover services of a given type and resolve them to host/port.
 * - Optional exact-or-prefix name filter (iOS-like behavior, handles " (n)" suffix).
 * - Timebox discovery; early-exit when the target match is resolved.
 *
 * Threading:
 * - All mutable state is confined to the main thread. NSD delivers the legacy listener callbacks on
 *   its own internal thread, so every callback coming from [NsdBackend] hops to main via [runOnMain]
 *   before it touches any state.
 *
 * Platform notes:
 * - Android NSD has no public API for TXT records.
 * - Before API 34 only one `resolveService` may be active at a time; resolves are queued here.
 */
class mDNS internal constructor(
    private val backend: NsdBackend,
    private val mainThread: MainThread,
    private val mainDispatcher: CoroutineDispatcher,
    private val externalScope: CoroutineScope?,
    private val publishTimeoutMs: Long,
    private val resolveTimeoutMs: Long
) {
    constructor(context: Context, externalScope: CoroutineScope? = null) : this(
        AndroidNsdBackend(context),
        AndroidMainThread(),
        Dispatchers.Main.immediate,
        externalScope,
        PUBLISH_TIMEOUT_MS,
        RESOLVE_TIMEOUT_MS
    )

    private companion object {
        const val PUBLISH_TIMEOUT_MS = 5000L
        const val RESOLVE_TIMEOUT_MS = 5000L
        const val RESOLVE_RETRY_DELAY_MS = 150L
        const val MAX_RESOLVE_RETRIES = 3
        val NAME_SUFFIX = Regex(""" \(\d+\)$""")
    }

    /** Normalized service representation returned to the bridge. */
    data class MdnsService(
        val name: String,
        val type: String,
        val hosts: List<String>, // numeric addresses (v4/v6)
        val port: Int
    )

    private class RegistrationSession(
        val onSuccess: (String) -> Unit,
        val onError: (Throwable) -> Unit
    ) {
        var timeoutJob: Job? = null
        var token: Any? = null
        var completed = false
        /** True once the OS confirmed the registration (so it can be unregistered safely). */
        var registered = false
        /** True once the caller no longer wants it; a late confirmation must be unregistered. */
        var cancelled = false
    }

    /** A discovered candidate waiting for (or undergoing) resolution. */
    private class Pending(val service: DiscoveredService) {
        var attempts = 0
        var done = false
        var token: Any? = null
        var timeoutJob: Job? = null
    }

    /** Optional external scope (from plugin); otherwise create our own on Main. */
    private val scope = externalScope ?: CoroutineScope(SupervisorJob() + mainDispatcher)
    private val discoverMutex = Mutex()

    // Main-thread confined state.
    private var activeRegistration: RegistrationSession? = null
    private var activeDiscovery: DiscoverySession? = null

    private fun runOnMain(block: () -> Unit) {
        if (mainThread.isCurrent()) block() else mainThread.post(block)
    }

    // ---- Broadcast -----------------------------------------------------------

    /**
     * Start advertising a service. If already registered, the previous one is unregistered first.
     *
     * @param typeRaw Service type; trailing dot appended if missing (e.g., "_http._tcp.")
     * @param name    Instance name; OS may append " (n)" to ensure uniqueness.
     * @param port    TCP port (> 0).
     * @param onSuccess Called with the (potentially uniquified) registered name.
     * @param onError   Called on registration failure.
     */
    fun broadcast(
        typeRaw: String,
        name: String,
        port: Int,
        onSuccess: (String) -> Unit,
        onError: (Throwable) -> Unit
    ) {
        require(port in 1..65535) { "Port must be between 1 and 65535" }
        val type = if (typeRaw.endsWith(".")) typeRaw else "$typeRaw."

        runOnMain {
            try {
                // Restarting while publish is pending must complete the old JS promise.
                stopActiveRegistration("Replaced by a new broadcast request")

                val session = RegistrationSession(onSuccess, onError)
                val listener = object : NsdBackend.RegistrationListener {
                    override fun onRegistered(publishedName: String) =
                        runOnMain { handleRegistered(session, publishedName) }

                    override fun onFailed(errorCode: Int) = runOnMain {
                        completeRegistrationError(
                            session,
                            IllegalStateException("Registration failed: $errorCode"),
                            clearActive = true
                        )
                    }
                }

                session.timeoutJob = scope.launch(mainDispatcher) {
                    delay(publishTimeoutMs)
                    session.cancelled = true
                    completeRegistrationError(
                        session,
                        IllegalStateException("Timed out waiting for service publish after ${publishTimeoutMs}ms"),
                        clearActive = true
                    )
                }

                activeRegistration = session
                try {
                    session.token = backend.registerService(type, name, port, listener)
                } catch (t: Throwable) {
                    completeRegistrationError(session, t, clearActive = true)
                }
            } catch (t: Throwable) {
                onError(t)
            }
        }
    }

    /**
     * Stop advertising the currently registered service (if any). Safe to call multiple times.
     */
    fun stopBroadcast() {
        runOnMain {
            stopActiveRegistration("Publish stopped before completion")
        }
    }

    // ---- Discover ------------------------------------------------------------

    /**
     * Discover services, optionally filtering by instance name using a normalized exact-or-prefix match.
     *
     * Behavior:
     * - Runs on the main dispatcher; concurrent calls are serialized.
     * - Resolves candidates to host/port.
     * - If `targetName` is provided, compare using normalized names and accept exact OR prefix match.
     * - Early-exits when a matching service is resolved (stops discovery immediately).
     * - Otherwise returns what was found when `timeoutMs` elapses.
     *
     * @param typeRaw     Service type; trailing dot appended if missing.
     * @param targetName  Optional instance name for normalized exact/prefix match.
     * @param timeoutMs   Timebox for discovery+resolve.
     * @return List of resolved services accumulated (or early-exit match).
     */
    suspend fun discover(
        typeRaw: String,
        targetName: String? = null,
        timeoutMs: Int = 3000
    ): List<MdnsService> = discoverMutex.withLock {
        withContext(mainDispatcher) {
            val type = if (typeRaw.endsWith(".")) typeRaw else "$typeRaw."
            val session = DiscoverySession(type, targetName)
            activeDiscovery = session
            try {
                session.start(timeoutMs.coerceAtLeast(0).toLong())
                session.result.await()
            } finally {
                // Cleanup in all cases (early-exit, timeout, error or cancellation).
                session.close()
                if (activeDiscovery === session) activeDiscovery = null
            }
        }
    }

    /**
     * Close the manager and release any outstanding NSD listeners.
     * Safe to call multiple times; also invoked by the plugin's handleOnDestroy().
     */
    fun close() {
        runOnMain {
            stopActiveRegistration("mDNS manager closed before publish completed")
            activeDiscovery?.fail(IllegalStateException("mDNS manager closed before discovery completed"))
        }
        if (externalScope == null) scope.cancel()
    }

    // ---- Registration helpers ------------------------------------------------

    private fun handleRegistered(session: RegistrationSession, publishedName: String) {
        if (session.cancelled) {
            // The caller gave up (stop/replace/timeout) before the OS confirmed: undo it now.
            safeUnregister(session)
            return
        }
        session.registered = true
        completeRegistrationSuccess(session, publishedName)
    }

    private fun completeRegistrationSuccess(session: RegistrationSession, publishedName: String) {
        if (session.completed) return
        session.completed = true
        session.timeoutJob?.cancel()
        session.onSuccess(publishedName)
    }

    private fun completeRegistrationError(
        session: RegistrationSession,
        error: Throwable,
        clearActive: Boolean
    ) {
        if (session.completed) return
        session.completed = true
        session.timeoutJob?.cancel()
        if (clearActive && activeRegistration === session) activeRegistration = null
        session.onError(error)
    }

    private fun stopActiveRegistration(reason: String) {
        val session = activeRegistration ?: return
        activeRegistration = null
        session.cancelled = true
        // Only unregister once the OS confirmed; otherwise handleRegistered() does it on arrival.
        if (session.registered) safeUnregister(session)
        if (!session.completed) {
            completeRegistrationError(session, IllegalStateException(reason), clearActive = false)
        } else {
            session.timeoutJob?.cancel()
        }
    }

    /** Best-effort unregister; NSD may throw if already unregistered. */
    private fun safeUnregister(session: RegistrationSession) {
        val token = session.token ?: return
        try { backend.unregisterService(token) } catch (_: Throwable) {}
    }

    // ---- Discovery session ---------------------------------------------------

    /** One discovery run. Every member is touched on the main thread only. */
    private inner class DiscoverySession(
        private val type: String,
        private val targetName: String?
    ) {
        val result = CompletableDeferred<List<MdnsService>>()

        private val found = mutableListOf<MdnsService>()
        private val seen = HashSet<String>()
        private val queue = ArrayDeque<Pending>()
        private val pendingResolves = mutableListOf<Pending>()
        private var resolveInFlight = false
        private var discoveryToken: Any? = null
        private var timeoutJob: Job? = null
        private var closed = false

        fun start(timeoutMs: Long) {
            timeoutJob = scope.launch(mainDispatcher) {
                delay(timeoutMs)
                finish()
            }
            val listener = object : NsdBackend.DiscoveryListener {
                override fun onStartFailed(errorCode: Int) = runOnMain {
                    fail(IllegalStateException("Discovery failed to start: $errorCode"))
                }

                override fun onFound(service: DiscoveredService) = runOnMain { handleFound(service) }
            }
            try {
                discoveryToken = backend.startDiscovery(type, listener)
            } catch (t: Throwable) {
                close()
                throw t
            }
        }

        /** Complete with whatever was resolved so far. */
        fun finish() {
            if (closed) return
            val snapshot = found.toList()
            close()
            result.complete(snapshot)
        }

        fun fail(error: Throwable) {
            if (closed) return
            close()
            result.completeExceptionally(error)
        }

        /** Idempotent: stops timers, resolves and the discovery itself. */
        fun close() {
            if (closed) return
            closed = true
            timeoutJob?.cancel()
            queue.clear()
            pendingResolves.forEach { p ->
                p.timeoutJob?.cancel()
                p.token?.let { safeCancelResolve(it) }
            }
            pendingResolves.clear()
            discoveryToken?.let { safeStopDiscovery(it) }
            discoveryToken = null
        }

        private fun handleFound(service: DiscoveredService) {
            if (closed) return
            if (!matchesTarget(service.name)) return
            // The OS reports the same service once per interface/address family.
            if (!seen.add("${service.name}|${service.type}")) return

            val pending = Pending(service)
            if (backend.supportsConcurrentResolve) {
                startResolve(pending)
            } else {
                queue.addLast(pending)
                pump()
            }
        }

        /** Legacy path: at most one resolve in flight. */
        private fun pump() {
            if (closed || resolveInFlight) return
            val next = queue.removeFirstOrNull() ?: return
            resolveInFlight = true
            startResolve(next)
        }

        private fun startResolve(p: Pending) {
            p.done = false
            pendingResolves.add(p)
            p.timeoutJob = scope.launch(mainDispatcher) {
                delay(resolveTimeoutMs)
                handleResolveTimeout(p)
            }
            val listener = object : NsdBackend.ResolveListener {
                override fun onResolved(service: MdnsService) = runOnMain { handleResolved(p, service) }
                override fun onFailed(errorCode: Int) = runOnMain { handleResolveFailed(p, errorCode) }
            }
            try {
                p.token = backend.resolve(p.service, listener)
            } catch (_: Throwable) {
                // Some Android releases throw when the NSD daemon is busy; drop this candidate.
                abandon(p)
            }
        }

        private fun handleResolved(p: Pending, service: MdnsService) {
            if (closed) return
            p.timeoutJob?.cancel()
            upsert(service)
            if (targetName != null && matchesTarget(service.name)) {
                finish()
                return
            }
            if (!backend.supportsConcurrentResolve) releaseSlot(p)
        }

        private fun handleResolveFailed(p: Pending, errorCode: Int) {
            if (closed) return
            p.timeoutJob?.cancel()
            if (backend.supportsConcurrentResolve) {
                pendingResolves.remove(p)
                return
            }
            if (errorCode == NsdManager.FAILURE_ALREADY_ACTIVE && p.attempts < MAX_RESOLVE_RETRIES) {
                // Somebody else owns the single resolve slot: try again shortly.
                p.attempts++
                pendingResolves.remove(p)
                resolveInFlight = false
                queue.addLast(p)
                scope.launch(mainDispatcher) {
                    delay(RESOLVE_RETRY_DELAY_MS)
                    pump()
                }
                return
            }
            releaseSlot(p)
        }

        private fun handleResolveTimeout(p: Pending) {
            if (closed || p.done) return
            abandon(p)
        }

        /** Give up on one candidate and let the queue move on. */
        private fun abandon(p: Pending) {
            p.timeoutJob?.cancel()
            p.token?.let { safeCancelResolve(it) }
            if (backend.supportsConcurrentResolve) {
                pendingResolves.remove(p)
            } else {
                releaseSlot(p)
            }
        }

        private fun releaseSlot(p: Pending) {
            if (p.done) return
            p.done = true
            p.timeoutJob?.cancel()
            pendingResolves.remove(p)
            resolveInFlight = false
            pump()
        }

        private fun upsert(item: MdnsService) {
            val index = found.indexOfFirst { it.name == item.name && it.type == item.type && it.port == item.port }
            if (index >= 0) found[index] = item else found.add(item)
        }

        private fun matchesTarget(candidate: String): Boolean {
            val target = targetName ?: return true // if no target, accept all
            val c = normalize(candidate)
            val t = normalize(target)
            return (c == t) || c.startsWith(t)
        }
    }

    /** Normalization for the " (n)" suffix appended by the OS. */
    private fun normalize(s: String): String = s.replace(NAME_SUFFIX, "")

    /** Best-effort stop discovery; NSD may throw if discovery is not active. */
    private fun safeStopDiscovery(token: Any) {
        try { backend.stopDiscovery(token) } catch (_: Throwable) {}
    }

    /** Best-effort stop service info updates; NSD may throw if not registered. */
    private fun safeCancelResolve(token: Any) {
        try { backend.cancelResolve(token) } catch (_: Throwable) {}
    }
}
