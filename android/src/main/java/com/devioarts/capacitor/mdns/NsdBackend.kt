package com.devioarts.capacitor.mdns
// English-only code and comments.

/**
 * Thin seam over `NsdManager` so the discovery/registration logic can be unit-tested on the JVM.
 *
 * Contract:
 * - Listener callbacks MAY be invoked from any thread (the real NSD service uses its own thread for
 *   the legacy overloads). The consumer ([mDNS]) is responsible for hopping to its main thread.
 * - Methods may throw; registration/stop failures must reach the caller.
 * - Returned tokens are opaque and only meaningful when handed back to the same backend.
 */
internal interface NsdBackend {

    /** True when several resolves can be in flight at once (API 34+ `ServiceInfoCallback`). */
    val supportsConcurrentResolve: Boolean

    fun acquireMulticastLock()
    fun releaseMulticastLock()

    fun registerService(type: String, name: String, port: Int, txt: Map<String, String>, listener: RegistrationListener): Any
    fun unregisterService(token: Any)

    fun startDiscovery(type: String, listener: DiscoveryListener): Any
    fun stopDiscovery(token: Any)

    /** Returns a token to hand to [cancelResolve], or null when there is nothing to cancel. */
    fun resolve(service: DiscoveredService, listener: ResolveListener): Any?
    fun cancelResolve(token: Any)

    interface RegistrationListener {
        fun onRegistered(publishedName: String)
        fun onFailed(errorCode: Int)
        fun onUnregistered()
        fun onUnregistrationFailed(errorCode: Int)
    }

    interface DiscoveryListener {
        fun onStartFailed(errorCode: Int)
        fun onFound(service: DiscoveredService)
        fun onLost(service: DiscoveredService) {}
        fun onStopFailed(errorCode: Int) {}
        fun onStopped() {}
    }

    interface ResolveListener {
        fun onResolved(service: mDNS.MdnsService)
        fun onFailed(errorCode: Int)
    }
}

/** A service reported by discovery but not resolved yet. [handle] is backend-specific. */
internal class DiscoveredService(val name: String, val type: String, val handle: Any? = null)

/** Abstraction over "the main thread" so tests can substitute their own single thread. */
internal interface MainThread {
    fun isCurrent(): Boolean
    fun post(block: () -> Unit)
}
