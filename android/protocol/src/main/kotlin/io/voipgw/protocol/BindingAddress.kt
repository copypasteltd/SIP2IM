package io.voipgw.protocol

import java.net.URI

/** Bind addresses must be an HTTP origin without credentials, path, query or fragment. */
object BindingAddress {
    fun origin(value: String): String {
        val uri = URI(value.trim())
        require(uri.scheme == "http" && uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null)
        require(uri.path.isNullOrEmpty() || uri.path == "/")
        require(uri.port in -1..65535 && uri.port != 0)
        return "http://" + (if (uri.host.contains(':')) "[${uri.host}]" else uri.host) + if (uri.port == -1) "" else ":${uri.port}"
    }
    fun code(value: String) = value.matches(Regex("[0-9]{6}"))
}
