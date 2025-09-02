package com.devioarts.capacitor.mdns
// English-only code and comments.

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.*
import java.util.concurrent.atomic.AtomicReference

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
 * - All public APIs are main-thread safe. Calls hop to the main looper internally,
 *   since NSD APIs deliver callbacks on the main thread and expect a looper.
 *
 * Platform notes:
 * - Android NSD has no public API for TXT records.
 */
class mDNS(
    context: Context,
    private val externalScope: CoroutineScope? = null
) {
    /** Normalized service representation returned to the bridge. */
    data class MdnsService(
        val name: String,
        val type: String,
        val host: String?, // numeric address (v4/v6) or null if resolve fails
        val port: Int
    )

    /** NSD system service. */
    private val nsd: NsdManager =
        context.getSystemService(Context.NSD_SERVICE) as NsdManager

    /** Keep strong references to listeners so they outlive registration/discovery. */
    private val regListenerRef = AtomicReference<NsdManager.RegistrationListener?>(null)
    private val discListenerRef = AtomicReference<NsdManager.DiscoveryListener?>(null)

    /** Optional external scope (from plugin); otherwise create our own on Main. */
    private val scope = externalScope ?: CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** Main looper utilities for non-suspending entry points. */
    private val mainHandler = Handler(Looper.getMainLooper())
    private inline fun runOnMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() === Looper.getMainLooper()) block() else mainHandler.post { block() }
    }

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
        require(port > 0) { "Port must be > 0" }
        val type = if (typeRaw.endsWith(".")) typeRaw else "$typeRaw."

        runOnMain {
            // Ensure a clean state before registering again.
            regListenerRef.getAndSet(null)?.let { safeUnregister(it) }

            val info = NsdServiceInfo().apply {
                serviceType = type
                serviceName = name
                setPort(port)
            }

            val listener = object : NsdManager.RegistrationListener {
                override fun onServiceRegistered(nsi: NsdServiceInfo) = onSuccess(nsi.serviceName)
                override fun onRegistrationFailed(nsi: NsdServiceInfo, errorCode: Int) =
                    onError(IllegalStateException("Registration failed: $errorCode"))
                override fun onServiceUnregistered(nsi: NsdServiceInfo) { /* no-op */ }
                override fun onUnregistrationFailed(nsi: NsdServiceInfo, errorCode: Int) { /* no-op */ }
            }

            regListenerRef.set(listener)
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
        }
    }

    /**
     * Stop advertising the currently registered service (if any). Safe to call multiple times.
     */
    fun stopBroadcast() {
        runOnMain {
            regListenerRef.getAndSet(null)?.let { safeUnregister(it) }
        }
    }

    /**
     * Discover services, optionally filtering by instance name using a normalized exact-or-prefix match.
     *
     * Behavior:
     * - Runs on the main dispatcher.
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
    ): List<MdnsService> = withContext(Dispatchers.Main.immediate) {
        val type = if (typeRaw.endsWith(".")) typeRaw else "$typeRaw."

        // Prepare state
        discListenerRef.getAndSet(null)?.let { safeStopDiscovery(it) }
        val found = mutableListOf<MdnsService>()
        val result = CompletableDeferred<List<MdnsService>>()

        // Normalization for "(n)" suffix appended by the OS.
        fun normalize(s: String): String = s.replace(Regex(" \\(\\d+\\)\$"), "")
        fun matchesTarget(candidate: String): Boolean {
            val c = normalize(candidate)
            val t = normalize(targetName ?: return true) // if no target, accept all
            return (c == t) || c.startsWith(t)
        }

        val listener = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                // Fail fast: stop discovery and complete with whatever we have (likely empty).
                safeStopDiscovery(this)
                if (!result.isCompleted) result.complete(found.toList())
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) { /* no-op */ }
            override fun onDiscoveryStarted(serviceType: String) { /* no-op */ }
            override fun onDiscoveryStopped(serviceType: String) { /* no-op */ }

            override fun onServiceFound(si: NsdServiceInfo) {
                if (targetName != null && !matchesTarget(si.serviceName)) return

                val discoveryListener = this
                nsd.resolveService(si, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(s: NsdServiceInfo, errorCode: Int) { /* ignore */ }

                    override fun onServiceResolved(s: NsdServiceInfo) {
                        val item = MdnsService(
                            name = s.serviceName,
                            type = s.serviceType,
                            host = s.host?.hostAddress,
                            port = s.port
                        )
                        found.add(item)

                        // Early-exit for exact/prefix target match.
                        if (targetName != null && matchesTarget(s.serviceName)) {
                            safeStopDiscovery(discoveryListener)
                            if (!result.isCompleted) result.complete(found.toList())
                        }
                    }
                })
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) { /* no-op */ }
        }

        // Start discovery and schedule timeout
        discListenerRef.set(listener)
        nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)

        val timeoutJob = scope.launch {
            delay(timeoutMs.toLong())
            safeStopDiscovery(listener)
            if (!result.isCompleted) result.complete(found.toList())
        }

        try {
            result.await()
        } finally {
            // Cleanup in all cases (early-exit or timeout)
            timeoutJob.cancel()
            discListenerRef.getAndSet(null)?.let { safeStopDiscovery(it) }
        }
    }

    /**
     * Close the manager and release any outstanding NSD listeners.
     * Safe to call multiple times; also invoked by the plugin's handleOnDestroy().
     */
    fun close() {
        stopBroadcast()
        discListenerRef.getAndSet(null)?.let { safeStopDiscovery(it) }
        if (externalScope == null) scope.cancel()
    }

    // ---- Internal helpers ----------------------------------------------------

    /** Best-effort unregister; NSD may throw if already unregistered. */
    private fun safeUnregister(l: NsdManager.RegistrationListener) {
        try { nsd.unregisterService(l) } catch (_: Throwable) {}
    }

    /** Best-effort stop discovery; NSD may throw if discovery is not active. */
    private fun safeStopDiscovery(l: NsdManager.DiscoveryListener) {
        try { nsd.stopServiceDiscovery(l) } catch (_: Throwable) {}
    }
}
