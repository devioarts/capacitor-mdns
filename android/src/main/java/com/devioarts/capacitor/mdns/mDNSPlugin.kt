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
 * - startBroadcast: { type?: string, name?: string, port: number, txt?: Record<string,string> }
 * - stopBroadcast:  {}
 * - discover:       { type?: string, name?: string, timeout?: number }
 *
 * Return shapes:
 * - startBroadcast -> { publishing: boolean, name: string, error: boolean, errorMessage: string|null }
 * - stopBroadcast  -> { publishing: boolean, error: boolean, errorMessage: string|null }
 * - discover       -> {
 *       error: boolean, errorMessage: string|null,
 *       servicesFound: number,
 *       services: Array<{ name, type, domain: "local.", port, hosts: string[] }>
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
        mdns.close { scope.cancel() }
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

    private fun jsResultStop(publishing: Boolean, error: Boolean, msg: String?): JSObject =
        JSObject().put("publishing", publishing)
            .put("error", error)
            .put("errorMessage", jnull(msg))

    private fun jsResultDiscover(error: Boolean, msg: String?, services: JSONArray): JSObject =
        JSObject()
            .put("error", error)
            .put("errorMessage", jnull(msg))
            .put("servicesFound", services.length())
            .put("services", services)

    private fun serviceObject(s: mDNS.MdnsService): JSObject = JSObject().apply {
        put("name", s.name)
        put("type", s.type)
        put("domain", "local.")
        put("port", s.port)
        put("hosts", JSONArray(s.hosts))
        if (s.txt.isNotEmpty()) put("txt", JSObject().apply { s.txt.forEach { (k, v) -> put(k, v) } })
    }

    // ----------------------- API -----------------------

    @PluginMethod
    fun getPluginPlatform(call: PluginCall) {
        call.resolve(JSObject().put("platform", "android"))
    }

    /**
     * Start advertising a Bonjour/mDNS service.
     * - type: default "_http._tcp."
     * - name: default DevIOArtsMDNS
     * - port: required (> 0)
     */
    @PluginMethod
    fun startBroadcast(call: PluginCall) {
        scope.launch {
            try {
                val type = MdnsValidation.type(MdnsOptions.string(call.data.opt("type"), "type"))
                val name = MdnsValidation.name(MdnsOptions.string(call.data.opt("name"), "name")).ifEmpty { "DevIOArtsMDNS" }
                val port = MdnsOptions.port(call.data.opt("port"))
                val txt = MdnsOptions.txt(call.data.opt("txt"))
                mdns.broadcast(
                    typeRaw = type,
                    name = name,
                    port = port,
                    txt = txt,
                    onSuccess = { published ->
                        call.resolve(jsResultBroadcast(true, published, false, null))
                    },
                    onError = { err ->
                        call.resolve(jsResultBroadcast(mdns.isPublishing, "", true, toErrorMessage(err)))
                    }
                )
            } catch (t: Throwable) {
                call.resolve(jsResultBroadcast(mdns.isPublishing, "", true, toErrorMessage(t)))
            }
        }
    }

    /**
     * Stop advertising the currently registered service.
     */
    @PluginMethod
    fun stopBroadcast(call: PluginCall) {
        try {
            mdns.stopBroadcast { publishing, error ->
                call.resolve(jsResultStop(publishing, error != null, error?.let { toErrorMessage(it) }))
            }
        } catch (t: Throwable) {
            call.resolve(jsResultStop(true, true, toErrorMessage(t)))
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
        scope.launch {
            try {
                val type = MdnsValidation.type(MdnsOptions.string(call.data.opt("type"), "type"))
                val targetName = MdnsValidation.name(MdnsOptions.string(call.data.opt("name"), "name")).takeIf { it.isNotEmpty() }
                val timeout = MdnsOptions.timeout(call.data.opt("timeout"))
                val list = mdns.discover(type, targetName, timeout)
                val arr = JSONArray(list.map { serviceObject(it) })
                call.resolve(jsResultDiscover(false, null, arr))
            } catch (t: Throwable) {
                call.resolve(jsResultDiscover(true, toErrorMessage(t), JSONArray()))
            }
        }
    }

    @PluginMethod
    fun watchServices(call: PluginCall) {
        val types = call.getArray("types")
        val raw = if (types == null) emptyList() else (0 until types.length()).map { types.opt(it) }
        if (raw.isEmpty() || raw.any { it !is String }) {
            call.resolve(JSObject().put("error", true).put("errorMessage", "Expected a nonempty array of service types").put("watchersStarted", 0))
            return
        }
        scope.launch {
            try {
                val started = mdns.watchServices(raw.map { it as String }, object : mDNS.WatchListener {
                    override fun onServiceFound(service: mDNS.MdnsService) {
                        notifyListeners("serviceFound", JSObject().put("service", serviceObject(service)))
                    }
                    override fun onServiceLost(service: mDNS.MdnsService) {
                        notifyListeners("serviceLost", JSObject().put("service", serviceObject(service)))
                    }
                    override fun onError(type: String, message: String, watching: Boolean) {
                        notifyListeners("watchError", JSObject().put("type", type).put("errorMessage", message).put("watching", watching))
                    }
                })
                call.resolve(JSObject().put("error", false).put("errorMessage", JSONObject.NULL).put("watchersStarted", started))
            } catch (t: Throwable) {
                call.resolve(JSObject().put("error", true).put("errorMessage", toErrorMessage(t)).put("watchersStarted", 0))
            }
        }
    }

    @PluginMethod
    fun stopWatching(call: PluginCall) {
        scope.launch {
            val error = mdns.stopWatching()
            call.resolve(JSObject().put("watching", false).put("error", error != null).put("errorMessage", jnull(error?.message)))
        }
    }
}
