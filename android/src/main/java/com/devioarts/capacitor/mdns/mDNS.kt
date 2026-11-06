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
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

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
 * - Resolved TXT records are available through NSD attributes.
 * - Before API 34 only one `resolveService` may be active at a time; resolves are queued here.
 */
class mDNS internal constructor(
    private val backend: NsdBackend,
    private val mainThread: MainThread,
    private val mainDispatcher: CoroutineDispatcher,
    private val externalScope: CoroutineScope?,
    private val publishTimeoutMs: Long,
    private val resolveTimeoutMs: Long,
    private val stopTimeoutMs: Long = 3000L
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
        val port: Int,
        val txt: Map<String, String> = emptyMap()
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
        var stopping = false
        var stopped = CompletableDeferred<Throwable?>()
        var lockHeld = false
    }

    /** A discovered candidate waiting for (or undergoing) resolution. */
    interface WatchListener {
        fun onServiceFound(service: MdnsService)
        fun onServiceLost(service: MdnsService)
        fun onError(type: String, message: String, watching: Boolean)
    }

    private inner class Pending(val owner: DiscoverySession, val service: DiscoveredService) {
        var attempts = 0
        var done = false
        var token: Any? = null
        var timeoutJob: Job? = null
        var retryJob: Job? = null
        var generation = 0
    }

    /** Optional external scope (from plugin); otherwise create our own on Main. */
    private val scope = externalScope ?: CoroutineScope(SupervisorJob() + mainDispatcher)
    private val discoverMutex = Mutex()
    private val broadcastMutex = Mutex()
    private val watchMutex = Mutex()
    private var closed = false

    // Main-thread confined state.
    private var activeRegistration: RegistrationSession? = null
    private var activeDiscovery: DiscoverySession? = null
    private var activeWatch: DiscoverySession? = null
    private val resolveQueue = ArrayDeque<Pending>()
    private val resolving = mutableSetOf<Pending>()
    private val discoveryStops = mutableMapOf<Any, CompletableDeferred<Throwable?>>()
    private val retryDiscoveryStops = mutableSetOf<Any>()
    internal val isPublishing: Boolean get() = activeRegistration != null

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

        scope.launch(mainDispatcher) {
            broadcastMutex.withLock {
                try {
                    check(!closed) { "mDNS manager is closed" }
                    // Restarting while publish is pending must complete the old JS promise.
                    stopActiveRegistration("Replaced by a new broadcast request")
                    check(!closed) { "mDNS manager is closed" }

                    val session = RegistrationSession(onSuccess, onError)
                    val listener = object : NsdBackend.RegistrationListener {
                        override fun onRegistered(publishedName: String) =
                            runOnMain { handleRegistered(session, publishedName) }

                        override fun onFailed(errorCode: Int) = runOnMain {
                            finishRegistration(session)
                            completeRegistrationError(
                                session,
                                IllegalStateException("Registration failed: $errorCode")
                            )
                        }

                        override fun onUnregistered() = runOnMain { finishRegistration(session) }

                        override fun onUnregistrationFailed(errorCode: Int) = runOnMain {
                            session.stopping = false
                            session.stopped.complete(IllegalStateException("Unregistration failed: $errorCode"))
                        }
                    }

                    session.timeoutJob = scope.launch(mainDispatcher) {
                        delay(publishTimeoutMs)
                        session.cancelled = true
                        completeRegistrationError(
                            session,
                            IllegalStateException("Timed out waiting for service publish after ${publishTimeoutMs}ms")
                        )
                        releaseRegistrationLock(session)
                    }

                    activeRegistration = session
                    try {
                        backend.acquireMulticastLock()
                        session.lockHeld = true
                        session.token = backend.registerService(type, name, port, listener)
                        if (session.cancelled && session.registered) unregister(session)
                    } catch (t: Throwable) {
                        finishRegistration(session)
                        completeRegistrationError(session, t)
                    }
                } catch (t: Throwable) {
                    onError(t)
                }
            }
        }
    }

    /**
     * Stop advertising the currently registered service (if any). Safe to call multiple times.
     */
    fun stopBroadcast(onComplete: (Boolean, Throwable?) -> Unit = { _, _ -> }) {
        scope.launch(mainDispatcher) {
            broadcastMutex.withLock {
                val error = try {
                    stopActiveRegistration("Publish stopped before completion")
                    null
                } catch (t: Throwable) { t }
                onComplete(isPublishing, error)
            }
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
            check(!closed) { "mDNS manager is closed" }
            val type = if (typeRaw.endsWith(".")) typeRaw else "$typeRaw."
            val session = DiscoverySession(listOf(type), targetName)
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
    fun close(onComplete: () -> Unit = {}) {
        runOnMain {
            closed = true
            val watch = activeWatch
            activeWatch = null
            watch?.close()
            activeDiscovery?.fail(IllegalStateException("mDNS manager closed before discovery completed"))
            scope.launch(mainDispatcher) {
                try {
                    watchMutex.withLock { stopWatch() }
                    broadcastMutex.withLock {
                        stopActiveRegistration("mDNS manager closed before publish completed")
                    }
                } catch (_: Throwable) {
                    // Keep the registration for cleanup if the OS confirms it after close.
                } finally {
                    activeRegistration?.let { releaseRegistrationLock(it) }
                    onComplete()
                    if (externalScope == null) scope.cancel()
                }
            }
        }
    }

    // ---- Registration helpers ------------------------------------------------

    private fun handleRegistered(session: RegistrationSession, publishedName: String) {
        session.registered = true
        if (session.cancelled) {
            // The caller gave up (stop/replace/timeout) before the OS confirmed: undo it now.
            unregister(session)
            return
        }
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
        error: Throwable
    ) {
        if (session.completed) return
        session.completed = true
        session.timeoutJob?.cancel()
        session.onError(error)
    }

    private suspend fun stopActiveRegistration(reason: String) {
        val session = activeRegistration ?: return
        session.cancelled = true
        completeRegistrationError(session, IllegalStateException(reason))
        if (session.stopped.isCompleted) session.stopped = CompletableDeferred()
        // An unconfirmed registration can only be undone after onRegistered arrives.
        if (session.registered) unregister(session)
        try {
            withTimeout(stopTimeoutMs) { session.stopped.await() }?.let { throw it }
        } catch (t: Throwable) {
            releaseRegistrationLock(session)
            if (t is TimeoutCancellationException) {
                throw IllegalStateException("Timed out waiting for service stop after ${stopTimeoutMs}ms")
            }
            throw t
        }
    }

    private fun unregister(session: RegistrationSession) {
        if (session.stopping) return
        val token = session.token ?: return
        session.stopping = true
        try {
            backend.unregisterService(token)
        } catch (t: Throwable) {
            session.stopping = false
            session.stopped.complete(t)
        }
    }

    private fun finishRegistration(session: RegistrationSession) {
        if (activeRegistration === session) activeRegistration = null
        releaseRegistrationLock(session)
        session.stopped.complete(null)
    }

    private fun releaseRegistrationLock(session: RegistrationSession) {
        if (!session.lockHeld) return
        session.lockHeld = false
        backend.releaseMulticastLock()
    }

    // ---- Discovery session ---------------------------------------------------

    /** Thanks to Idrimi for the original continuous discovery feature (PR #7). */
    suspend fun watchServices(typesRaw: List<String>, listener: WatchListener): Int = watchMutex.withLock { withContext(mainDispatcher) {
        check(!closed) { "mDNS manager is closed" }
        require(typesRaw.isNotEmpty()) { "Missing or empty 'types' array" }
        val types = typesRaw.map { raw ->
            val type = raw.trim().removeSuffix(".")
            require(Regex("^_[^.]+\\._(tcp|udp)$").matches(type)) { "Invalid service type: $raw" }
            "$type."
        }.distinct()
        stopWatch()?.let { throw it }
        check(!closed) { "mDNS manager is closed" }
        val session = DiscoverySession(types, null, listener)
        activeWatch = session
        try {
            session.start(null)
            types.size
        } catch (t: Throwable) {
            session.close()
            if (activeWatch === session) activeWatch = null
            throw t
        }
    } }

    suspend fun stopWatching(): Throwable? = watchMutex.withLock { withContext(mainDispatcher) { stopWatch() } }

    private suspend fun stopWatch(): Throwable? {
        val old = activeWatch
        activeWatch = null
        val errors = mutableListOf<Throwable>()
        old?.close()
        for ((token, initial) in discoveryStops.toMap()) {
            val result = if (retryDiscoveryStops.remove(token)) requestDiscoveryStop(token) else initial
            val error = try { withTimeout(stopTimeoutMs) { result.await() } }
            catch (t: Throwable) { if (t is TimeoutCancellationException) IllegalStateException("Timed out waiting for discovery stop") else t }
            if (error != null) { retryDiscoveryStops += token; errors += error }
        }
        return errors.firstOrNull()
    }

    private fun requestDiscoveryStop(token: Any): CompletableDeferred<Throwable?> {
        val result = CompletableDeferred<Throwable?>()
        discoveryStops[token] = result
        try { backend.stopDiscovery(token) }
        catch (t: Throwable) { result.complete(t) }
        return result
    }

    /** Discovery and watching share the device's single legacy resolver slot. */
    private fun enqueue(p: Pending) {
        if (p.done) return
        if (backend.supportsConcurrentResolve) startResolve(p)
        else { resolveQueue.addLast(p); pump() }
    }

    private fun pump() {
        if (resolving.isNotEmpty()) return
        val p = resolveQueue.removeFirstOrNull() ?: return
        startResolve(p)
    }

    private fun startResolve(p: Pending) {
        if (p.done) return
        val generation = ++p.generation
        resolving.add(p)
        p.timeoutJob = scope.launch(mainDispatcher) {
            delay(resolveTimeoutMs)
            if (p.generation != generation) return@launch
            resolveFailed(p, "Timed out resolving ${p.service.name}", retry = p.owner.isWatching)
        }
        val listener = object : NsdBackend.ResolveListener {
            override fun onResolved(service: MdnsService) = runOnMain {
                if (p.done || p.generation != generation || p !in resolving) return@runOnMain
                finishResolve(p)
                p.owner.resolved(p, service)
                pump()
            }
            override fun onFailed(errorCode: Int) = runOnMain {
                if (p.generation != generation) return@runOnMain
                resolveFailed(p, "Resolve failed: $errorCode", p.owner.isWatching || errorCode == NsdManager.FAILURE_ALREADY_ACTIVE)
            }
        }
        try {
            p.token = backend.resolve(p.service, listener)
            if (p.done) p.token?.let { safeCancelResolve(it) }
        } catch (t: Throwable) {
            resolveFailed(p, t.message ?: "Resolve failed", retry = p.owner.isWatching)
        }
    }

    private fun resolveFailed(p: Pending, message: String, retry: Boolean) {
        if (p.done || p !in resolving) return
        p.timeoutJob?.cancel()
        resolving.remove(p)
        p.token?.let { safeCancelResolve(it) }
        p.token = null
        if (retry && p.attempts++ < MAX_RESOLVE_RETRIES) {
            p.retryJob = scope.launch(mainDispatcher) {
                delay(RESOLVE_RETRY_DELAY_MS)
                enqueue(p)
            }
        } else {
            p.done = true
            p.owner.resolveFailed(p, message)
        }
        pump()
    }

    private fun finishResolve(p: Pending) {
        p.done = true
        p.timeoutJob?.cancel()
        p.retryJob?.cancel()
        resolveQueue.remove(p)
        resolving.remove(p)
        p.token?.let { safeCancelResolve(it) }
    }

    /** One browser group, with its own membership, callbacks and multicast lock. */
    private inner class DiscoverySession(
        private val types: List<String>,
        private val targetName: String?,
        private val watchListener: WatchListener? = null
    ) {
        val result = CompletableDeferred<List<MdnsService>>()
        val isWatching get() = watchListener != null
        private val found = linkedMapOf<String, MdnsService>()
        private val pending = mutableMapOf<String, Pending>()
        private val discoveryTokens = mutableListOf<Any>()
        private var timeoutJob: Job? = null
        private var closed = false
        private var lockHeld = false

        fun start(timeoutMs: Long?) {
            backend.acquireMulticastLock()
            lockHeld = true
            if (timeoutMs != null) timeoutJob = scope.launch(mainDispatcher) {
                delay(timeoutMs)
                finish()
            }
            for (type in types) {
                if (closed) return
                var token: Any? = null
                var startFailed = false
                val listener = object : NsdBackend.DiscoveryListener {
                    override fun onStartFailed(errorCode: Int) = runOnMain {
                        startFailed = true
                        discoveryTokens.remove(token)
                        fail(IllegalStateException("Discovery failed to start: $errorCode"), type)
                    }
                    override fun onStopFailed(errorCode: Int) = runOnMain {
                        val error = IllegalStateException("Discovery failed to stop: $errorCode")
                        if (closed) token?.let { discoveryStops[it]?.complete(error) }
                        else fail(error, type)
                    }
                    override fun onStopped() = runOnMain {
                        token?.let { discoveryStops.remove(it)?.complete(null); retryDiscoveryStops.remove(it) }
                        if (!closed) fail(IllegalStateException("Discovery stopped unexpectedly"), type)
                    }
                    override fun onFound(service: DiscoveredService) = runOnMain {
                        handleFound(DiscoveredService(service.name, type, service.handle))
                    }
                    override fun onLost(service: DiscoveredService) = runOnMain {
                        if (closed || !isWatching) return@runOnMain
                        val key = key(service.name, type)
                        pending.remove(key)?.let { finishResolve(it); pump() }
                        found.remove(key)?.let { watchListener?.onServiceLost(it) }
                    }
                }
                val startedToken = backend.startDiscovery(type, listener)
                token = startedToken
                if (startFailed) continue
                if (closed) requestDiscoveryStop(startedToken) else discoveryTokens += startedToken
            }
        }

        fun finish() {
            if (closed) return
            val snapshot = found.values.toList()
            close()
            result.complete(snapshot)
        }

        fun fail(error: Throwable, type: String = types.first()) {
            if (closed) return
            close()
            if (isWatching) {
                if (activeWatch === this) activeWatch = null
                watchListener?.onError(type, error.message ?: "Discovery failed", false)
            } else result.completeExceptionally(error)
        }

        fun close() {
            if (closed) return
            closed = true
            timeoutJob?.cancel()
            pending.values.toList().forEach { finishResolve(it) }
            pending.clear()
            pump()
            for (token in discoveryTokens) {
                requestDiscoveryStop(token)
            }
            discoveryTokens.clear()
            if (lockHeld) {
                lockHeld = false
                backend.releaseMulticastLock()
            }
        }

        private fun key(name: String, type: String) = "$name|$type"

        private fun handleFound(service: DiscoveredService) {
            if (closed || !matchesTarget(service.name)) return
            val key = key(service.name, service.type)
            if (key in found || key in pending) return
            val p = Pending(this, service)
            pending[key] = p
            enqueue(p)
        }

        fun resolved(p: Pending, service: MdnsService) {
            val key = key(p.service.name, p.service.type)
            if (closed || pending.remove(key) !== p) return
            val item = service.copy(type = p.service.type, hosts = service.hosts.toList(), txt = service.txt.toMap())
            found[key] = item
            if (isWatching) watchListener?.onServiceFound(item)
            else if (targetName != null && matchesTarget(item.name)) finish()
        }

        fun resolveFailed(p: Pending, message: String) {
            if (closed || pending.remove(key(p.service.name, p.service.type)) !== p) return
            watchListener?.onError(p.service.type, message, true)
        }

        private fun matchesTarget(candidate: String): Boolean {
            val target = targetName ?: return true
            return normalize(candidate).startsWith(normalize(target))
        }
    }

    /** Normalization for the " (n)" suffix appended by the OS. */
    private fun normalize(s: String): String = s.replace(NAME_SUFFIX, "")

    /** Best-effort stop service info updates; NSD may throw if not registered. */
    private fun safeCancelResolve(token: Any) {
        try { backend.cancelResolve(token) } catch (_: Throwable) {}
    }
}
