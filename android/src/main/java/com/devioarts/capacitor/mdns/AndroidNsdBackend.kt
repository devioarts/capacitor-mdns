package com.devioarts.capacitor.mdns
// English-only code and comments.

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executor

/** Production [MainThread] backed by the application's main looper. */
internal class AndroidMainThread : MainThread {
    private val handler = Handler(Looper.getMainLooper())
    override fun isCurrent(): Boolean = Looper.myLooper() === Looper.getMainLooper()
    override fun post(block: () -> Unit) {
        handler.post { block() }
    }
}

/**
 * Production [NsdBackend] on top of Android's `NsdManager`.
 *
 * Callbacks of the legacy overloads are delivered on NsdManager's internal thread, so this class
 * does not touch any shared state from them: it only translates and forwards.
 */
internal class AndroidNsdBackend(context: Context) : NsdBackend {

    private val nsd: NsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor { command -> mainHandler.post(command) }

    override val supportsConcurrentResolve: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE

    override fun registerService(
        type: String,
        name: String,
        port: Int,
        listener: NsdBackend.RegistrationListener
    ): Any {
        val info = NsdServiceInfo().apply {
            serviceType = type
            serviceName = name
            setPort(port)
        }
        val nsdListener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(nsi: NsdServiceInfo) = listener.onRegistered(nsi.serviceName)
            override fun onRegistrationFailed(nsi: NsdServiceInfo, errorCode: Int) = listener.onFailed(errorCode)
            override fun onServiceUnregistered(nsi: NsdServiceInfo) { /* no-op */ }
            override fun onUnregistrationFailed(nsi: NsdServiceInfo, errorCode: Int) { /* no-op */ }
        }
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, nsdListener)
        return nsdListener
    }

    override fun unregisterService(token: Any) {
        nsd.unregisterService(token as NsdManager.RegistrationListener)
    }

    override fun startDiscovery(type: String, listener: NsdBackend.DiscoveryListener): Any {
        val nsdListener = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = listener.onStartFailed(errorCode)
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) { /* no-op */ }
            override fun onDiscoveryStarted(serviceType: String) { /* no-op */ }
            override fun onDiscoveryStopped(serviceType: String) { /* no-op */ }
            override fun onServiceFound(si: NsdServiceInfo) =
                listener.onFound(DiscoveredService(si.serviceName, si.serviceType, si))
            override fun onServiceLost(serviceInfo: NsdServiceInfo) { /* no-op */ }
        }
        nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, nsdListener)
        return nsdListener
    }

    override fun stopDiscovery(token: Any) {
        nsd.stopServiceDiscovery(token as NsdManager.DiscoveryListener)
    }

    @Suppress("DEPRECATION")
    override fun resolve(service: DiscoveredService, listener: NsdBackend.ResolveListener): Any? {
        val si = service.handle as NsdServiceInfo

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val callback = object : NsdManager.ServiceInfoCallback {
                override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = listener.onFailed(errorCode)
                override fun onServiceInfoCallbackUnregistered() { /* no-op */ }
                override fun onServiceLost() { /* no-op */ }
                override fun onServiceUpdated(serviceInfo: NsdServiceInfo) =
                    listener.onResolved(toMdnsService(serviceInfo))
            }
            nsd.registerServiceInfoCallback(si, mainExecutor, callback)
            return callback
        }

        nsd.resolveService(si, object : NsdManager.ResolveListener {
            override fun onResolveFailed(s: NsdServiceInfo, errorCode: Int) = listener.onFailed(errorCode)
            override fun onServiceResolved(s: NsdServiceInfo) = listener.onResolved(toMdnsService(s))
        })
        return null
    }

    override fun cancelResolve(token: Any) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            token is NsdManager.ServiceInfoCallback
        ) {
            nsd.unregisterServiceInfoCallback(token)
        }
    }

    private fun toMdnsService(s: NsdServiceInfo): mDNS.MdnsService =
        mDNS.MdnsService(
            name = s.serviceName,
            type = s.serviceType,
            hosts = hostAddresses(s),
            port = s.port
        )

    private fun hostAddresses(s: NsdServiceInfo): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            s.hostAddresses.mapNotNull { it.hostAddress }
        } else {
            @Suppress("DEPRECATION")
            s.host?.hostAddress?.let { listOf(it) } ?: emptyList()
        }
}
