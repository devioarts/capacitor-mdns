package com.devioarts.capacitor.mdns

import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.PluginMethod
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

/**
 * Capacitor Android bridge for the mDNS plugin.
 *
 * Responsibilities:
 * - Own a single instance of the mDNS manager (Android NSD wrapper).
 * - Translate Capacitor calls (JS) to Kotlin calls and normalize results.
 * - Never reject for runtime errors; always resolve with { error, errorMessage }.
 *
 * Parameters (strict, no legacy):
 * - startBroadcast: { type?: string, name?: string, port: number, txt?: Record<string,string> }  // txt ignored by Android
 * - stopBroadcast:  {}
 * - discover:       { type?: string, name?: string, timeout?: number }
 *
 * Return shapes:
 * - startBroadcast -> { publishing: boolean, name: string, error: boolean, errorMessage: string|null }
 * - stopBroadcast  -> { publishing: false, error: boolean, errorMessage: string|null }
 * - discover       -> {
 *       error: boolean, errorMessage: string|null,
 *       servicesFound: number,
 *       services: Array<{ name, type, domain: "local.", port, hosts?: string[] }>
 *   }
 */
@CapacitorPlugin(name = "mDNS")
class mDNSPlugin : Plugin() {

    private val scope = MainScope()
    private lateinit var mdns: mDNS

    override fun load() {
        val ctx = context ?: throw IllegalStateException("No Android context")
        mdns = mDNS(ctx, scope)
    }

    override fun handleOnDestroy() {
        mdns.close()
        scope.cancel()
    }

    // ----------------------- Helpers -----------------------

    private fun toErrorMessage(t: Throwable?): String =
        t?.message ?: "Unknown error"

    private fun jnull(msg: String?): Any = msg ?: JSONObject.NULL

    private fun jsResultBroadcast(publishing: Boolean, name: String, error: Boolean, msg: String?): JSObject =
        JSObject().put("publishing", publishing)
            .put("name", name)
            .put("error", error)
            .put("errorMessage", jnull(msg))

    private fun jsResultStop(error: Boolean, msg: String?): JSObject =
        JSObject().put("publishing", false)
            .put("error", error)
            .put("errorMessage", jnull(msg))

    private fun jsResultDiscover(error: Boolean, msg: String?, services: JSONArray): JSObject =
        JSObject()
            .put("error", error)
            .put("errorMessage", jnull(msg))
            .put("servicesFound", services.length())
            .put("services", services)

    // ----------------------- API -----------------------

    /**
     * Start advertising a Bonjour/mDNS service.
     * - type: default "_http._tcp."
     * - name: default packageName
     * - port: required (> 0)
     */
    @PluginMethod
    fun startBroadcast(call: PluginCall) {
        val type = call.getString("type") ?: "_http._tcp."
        val name = call.getString("name") ?: (context?.packageName ?: "DevIOArtsMDNS")
        val port = call.getInt("port") ?: 0

        if (port <= 0) {
            call.resolve(jsResultBroadcast(false, "", true, "Missing/invalid port"))
            return
        }

        try {
            mdns.broadcast(
                typeRaw = type,
                name = name,
                port = port,
                onSuccess = { published ->
                    call.resolve(jsResultBroadcast(true, published, false, null))
                },
                onError = { err ->
                    call.resolve(jsResultBroadcast(false, "", true, toErrorMessage(err)))
                }
            )
        } catch (t: Throwable) {
            call.resolve(jsResultBroadcast(false, "", true, toErrorMessage(t)))
        }
    }

    /**
     * Stop advertising the currently registered service.
     */
    @PluginMethod
    fun stopBroadcast(call: PluginCall) {
        try {
            mdns.stopBroadcast()
            call.resolve(jsResultStop(false, null))
        } catch (t: Throwable) {
            call.resolve(jsResultStop(true, toErrorMessage(t)))
        }
    }

    /**
     * Discover services of a given type and optional name filter (exact/prefix, normalized).
     * - type: default "_http._tcp."
     * - name: optional filter
     * - timeout: default 3000
     */
    @PluginMethod
    fun discover(call: PluginCall) {
        val type = call.getString("type") ?: "_http._tcp."
        val targetName = call.getString("name")
        val timeout = call.getInt("timeout") ?: 3000

        scope.launch {
            try {
                val list = mdns.discover(type, targetName, timeout)
                val arr = JSONArray(list.map { s ->
                    JSObject().apply {
                        put("name", s.name)
                        put("type", s.type)         // Android returns full type with dot
                        put("domain", "local.")     // NSD is mDNS only
                        // normalize hosts to [] or [addr]
                        val hosts = JSONArray()
                        val addr = s.host
                        if (!addr.isNullOrEmpty()) hosts.put(addr)
                        put("hosts", hosts)
                        put("port", s.port)
                        // TXT not available via NSD -> omitted on Android
                    }
                })
                call.resolve(jsResultDiscover(false, null, arr))
            } catch (t: Throwable) {
                call.resolve(jsResultDiscover(true, toErrorMessage(t), JSONArray()))
            }
        }
    }
}
