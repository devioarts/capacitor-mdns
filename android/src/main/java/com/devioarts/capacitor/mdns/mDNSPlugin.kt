package com.devioarts.capacitor.mdns

import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.PluginMethod
import kotlinx.coroutines.*
import org.json.JSONArray

/**
 * Capacitor Android bridge for the mDNS plugin.
 *
 * Responsibilities:
 * - Own a single instance of the mDNS manager (Android NSD wrapper).
 * - Translate Capacitor calls (JS) to Kotlin calls and normalize results.
 * - Handle lifecycle cleanup to avoid leaked listeners/coroutines.
 *
 * Notes:
 * - The plugin mirrors the iOS API: startBroadcast / stopBroadcast / discover.
 * - TXT records are not exposed by Android NSD, therefore discovery result omits TXT on Android.
 */
@CapacitorPlugin(name = "mDNS")
class mDNSPlugin : Plugin() {

    /** MainScope is enough; we cancel it in handleOnDestroy() to avoid leaks. */
    private val scope = MainScope()

    /** Lazily created in load(); throws if Android context is somehow unavailable. */
    private lateinit var mdns: mDNS

    override fun load() {
        val ctx = context ?: throw IllegalStateException("No Android context")
        mdns = mDNS(ctx, scope)
    }

    override fun handleOnDestroy() {
        // Make sure to release NSD listeners and cancel any outstanding coroutines.
        mdns.close()
        scope.cancel()
    }

    // ---------- Public API: mirrors iOS ----------

    /**
     * Start advertising a Bonjour/mDNS service.
     *
     * Expected options (from JS/TS):
     *   {
     *     type?: string = "_cap-mdns._tcp.",   // trailing dot is appended if missing
     *     id?: string = packageName,           // service instance name
     *     port: number                         // required, > 0
     *   }
     *
     * Resolves with: { publishing: true, name: string }
     */
    @PluginMethod
    fun startBroadcast(call: PluginCall) {
        val type = call.getString("type") ?: "_http._tcp."
        val name = call.getString("id") ?: (context?.packageName ?: "mDNS")
        val port = call.getInt("port") ?: 0
        if (port <= 0) {
            call.reject("Missing/invalid port"); return
        }
        try {
            mdns.broadcast(
                typeRaw = type,
                name = name,
                port = port,
                onSuccess = { published ->
                    // "name" may differ if the OS uniquifies the instance (e.g., " (2)")
                    call.resolve(JSObject().put("publishing", true).put("name", published))
                },
                onError = { err -> call.reject(err.message ?: "Registration error") }
            )
        } catch (t: Throwable) {
            call.reject(t.message)
        }
    }

    /**
     * Stop advertising the currently registered service. No-op if nothing is registered.
     *
     * Resolves with an empty object for convenience.
     */
    @PluginMethod
    fun stopBroadcast(call: PluginCall) {
        mdns.stopBroadcast()
        call.resolve(JSObject().put("publishing", false))
    }

    /**
     * Discover services of a given type and optionally filter by instance name.
     *
     * Expected options:
     *   {
     *     type?: string = "_http._tcp.",
     *     id?: string,               // normalized exact or prefix match
     *     timeoutMs?: number = 3000
     *   }
     *
     * Resolves with:
     *   {
     *     services: Array<{
     *       name: string,
     *       type: string,
     *       domain?: string,   // "local." (normalized for parity with iOS)
     *       hosts?: string[],  // single item on Android, normalized to array
     *       port: number
     *     }>
     *   }
     */
    @PluginMethod
    fun discover(call: PluginCall) {
        val type = call.getString("type") ?: "_http._tcp."
        val targetId = call.getString("id") // optional exact name (Android NSD does not handle "(n)" suffix normalization)
        val timeoutMs = call.getInt("timeoutMs") ?: 3000

        scope.launch {
            try {
                val services = mdns.discover(type, targetId, timeoutMs)
                val arr = JSONArray(services.map { s ->
                    JSObject().apply {
                        put("name", s.name)
                        put("type", s.type)
                        // Android NSD gives a single numeric host; we normalize it to hosts: string[]
                        put("hosts", JSONArray().put(s.host ?: ""))
                        put("port", s.port)
                        // Android NSD does not provide TXT via public APIs; omit it for parity with iOS schema.
                        put("domain", "local.")
                    }
                })
                call.resolve(JSObject().put("services", arr))
            } catch (t: Throwable) {
                call.reject(t.message ?: "Discovery error")
            }
        }
    }
}
