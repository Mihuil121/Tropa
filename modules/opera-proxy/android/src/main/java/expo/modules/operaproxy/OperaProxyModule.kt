package expo.modules.operaproxy

import android.content.Context
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.io.File
import java.io.InputStreamReader
import java.io.BufferedReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.LinkedList
import java.util.concurrent.atomic.AtomicInteger

class OperaProxyModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "ReactContext is null" }

  private val lock = Any()
  @Volatile private var process: Process? = null
  @Volatile private var currentPort: Int = 0
  @Volatile private var currentCountry: String = "EU"
  @Volatile private var currentServerSelection: String = "first"
  @Volatile private var currentInitRetries: Int = 3
  @Volatile private var currentTimeout: String = "10s"
  @Volatile private var currentApiProxyFile: String? = null
  @Volatile private var currentProbeHost: String = "overpass-api.de:443"

  @Volatile private var currentState: String = "stopped"
  @Volatile private var lastError: String? = null

  private val generationCounter = AtomicInteger(0)
  private val pendingPromises = mutableListOf<Promise>()

  private val logBuffer = LinkedList<String>()
  private val executor = Executors.newCachedThreadPool()

  override fun definition() = ModuleDefinition {
    Name("OperaProxy")

    Events("onLog")

    Function("isSupported") {
      isSupported()
    }

    Function("status") {
      synchronized(lock) {
        if (!isSupported()) {
          return@Function mapOf(
            "state" to "failed",
            "country" to currentCountry,
            "lastError" to "Не поддерживается на этом устройстве"
          )
        }
        mapOf(
          "state" to currentState,
          "port" to if (currentState == "ready" && currentPort > 0) currentPort else null,
          "country" to currentCountry,
          "lastError" to lastError
        )
      }
    }

    AsyncFunction("start") { options: Map<String, Any?>?, promise: Promise ->
      val reqCountry = (options?.get("country") as? String)?.uppercase() ?: "EU"
      if (reqCountry !in listOf("EU", "AS", "AM")) {
        promise.reject("ERR_BAD_OPTIONS", "Неверный country: $reqCountry", null)
        return@AsyncFunction
      }

      val reqServerSelection = (options?.get("serverSelection") as? String)?.lowercase() ?: "first"
      if (reqServerSelection !in listOf("first", "random", "fastest")) {
        promise.reject("ERR_BAD_OPTIONS", "Неверный serverSelection: $reqServerSelection", null)
        return@AsyncFunction
      }

      val reqInitRetries = (options?.get("initRetries") as? Number)?.toInt() ?: 3
      val reqTimeout = (options?.get("timeout") as? String) ?: "10s"
      if (!reqTimeout.matches(Regex("^\\d+[smh]$"))) {
        promise.reject("ERR_BAD_OPTIONS", "Неверный timeout формат: $reqTimeout", null)
        return@AsyncFunction
      }

      val reqApiProxyFile = options?.get("apiProxyFile") as? String
      if (!reqApiProxyFile.isNullOrBlank() && !File(reqApiProxyFile).exists()) {
        promise.reject("ERR_BAD_OPTIONS", "Файл apiProxyFile не существует: $reqApiProxyFile", null)
        return@AsyncFunction
      }

      val reqProbeHost = (options?.get("probeHost") as? String) ?: "overpass-api.de:443"

      val gen: Int
      synchronized(lock) {
        if (currentState == "ready" && isPortOpen(currentPort) &&
            currentCountry == reqCountry &&
            currentServerSelection == reqServerSelection &&
            currentInitRetries == reqInitRetries &&
            currentTimeout == reqTimeout &&
            currentApiProxyFile == reqApiProxyFile &&
            currentProbeHost == reqProbeHost) {
          promise.resolve(mapOf("port" to currentPort))
          return@AsyncFunction
        }

        if (currentState == "starting" &&
            currentCountry == reqCountry &&
            currentServerSelection == reqServerSelection &&
            currentInitRetries == reqInitRetries &&
            currentTimeout == reqTimeout &&
            currentApiProxyFile == reqApiProxyFile &&
            currentProbeHost == reqProbeHost) {
          pendingPromises.add(promise)
          return@AsyncFunction
        }

        for (p in pendingPromises) {
          try { p.reject("ERR_CANCELLED", "Запуск отменен новым запросом", null) } catch (_: Exception) {}
        }
        pendingPromises.clear()
        pendingPromises.add(promise)

        stopProcessLocked()
        currentState = "starting"
        lastError = null

        currentCountry = reqCountry
        currentServerSelection = reqServerSelection
        currentInitRetries = reqInitRetries
        currentTimeout = reqTimeout
        currentApiProxyFile = reqApiProxyFile
        currentProbeHost = reqProbeHost

        gen = generationCounter.incrementAndGet()
      }

      val freePort = findFreePort()
      synchronized(lock) {
        if (generationCounter.get() != gen) return@AsyncFunction
        currentPort = freePort
      }

      executor.execute {
        try {
          val libFile = File(context.applicationInfo.nativeLibraryDir, "libopera_proxy.so")
          if (!libFile.exists()) {
            synchronized(lock) {
              if (generationCounter.get() == gen) {
                currentState = "failed"
                lastError = "libopera_proxy.so не найден"
                rejectAllPending("ERR_NOT_SUPPORTED", lastError)
              }
            }
            return@execute
          }

          val cmd = mutableListOf(
            libFile.absolutePath,
            "-bind-address", "127.0.0.1:$freePort",
            "-country", reqCountry,
            "-server-selection", reqServerSelection,
            "-init-retries", reqInitRetries.toString(),
            "-timeout", reqTimeout
          )
          if (!reqApiProxyFile.isNullOrBlank()) {
            cmd.add("-api-proxy-file")
            cmd.add(reqApiProxyFile)
          }

          Log.d("OperaProxy", "Запуск [gen $gen]: ${cmd.joinToString(" ")}")
          val pb = ProcessBuilder(cmd)
          pb.directory(context.filesDir)
          val proc = pb.start()

          synchronized(lock) {
            if (generationCounter.get() != gen) {
              try { proc.destroyForcibly() } catch (_: Exception) {}
              return@execute
            }
            process = proc
          }

          // Чтение stdout
          executor.execute {
            try {
              val reader = BufferedReader(InputStreamReader(proc.inputStream))
              var line: String?
              while (reader.readLine().also { line = it } != null) {
                val masked = maskSensitive(line ?: "")
                addLogLine(masked)
              }
            } catch (_: Exception) {}
          }

          // Чтение stderr
          executor.execute {
            try {
              val reader = BufferedReader(InputStreamReader(proc.errorStream))
              var line: String?
              while (reader.readLine().also { line = it } != null) {
                val masked = maskSensitive(line ?: "")
                addLogLine(masked)
              }
            } catch (_: Exception) {}
          }

          val startTime = System.currentTimeMillis()
          var ready = false
          while (System.currentTimeMillis() - startTime < 25000) {
            if (generationCounter.get() != gen) {
              try { proc.destroyForcibly() } catch (_: Exception) {}
              return@execute
            }
            if (!proc.isAlive) break
            if (isProxyReady(freePort, reqProbeHost)) {
              ready = true
              break
            }
            Thread.sleep(500)
          }

          synchronized(lock) {
            if (generationCounter.get() != gen) {
              try { proc.destroyForcibly() } catch (_: Exception) {}
              return@execute
            }

            if (ready && proc.isAlive) {
              currentState = "ready"
              resolveAllPending(mapOf("port" to freePort))

              // Наблюдатель за процессом (waitFor)
              executor.execute {
                try {
                  val exitCode = proc.waitFor()
                  synchronized(lock) {
                    if (generationCounter.get() == gen && currentState == "ready") {
                      currentState = "failed"
                      val recentLogs = synchronized(logBuffer) { logBuffer.takeLast(5).joinToString("\n") }
                      lastError = "Процесс завершился с кодом $exitCode\n$recentLogs"
                      Log.e("OperaProxy", lastError ?: "Процесс упал")
                    }
                  }
                } catch (_: Exception) {}
              }
            } else {
              stopProcessLocked()
              currentState = "failed"
              val recentLogs = synchronized(logBuffer) { logBuffer.takeLast(5).joinToString("\n") }
              lastError = if (recentLogs.isNotBlank()) recentLogs else "Таймаут старта прокси (25 с)"
              rejectAllPending("ERR_START_FAILED", lastError)
            }
          }
        } catch (e: Exception) {
          synchronized(lock) {
            if (generationCounter.get() == gen) {
              stopProcessLocked()
              currentState = "failed"
              lastError = e.message
              rejectAllPending("ERR_START_FAILED", e.message)
            }
          }
        }
      }
    }

    Function("stop") {
      synchronized(lock) {
        generationCounter.incrementAndGet()
        for (p in pendingPromises) {
          try { p.reject("ERR_CANCELLED", "Остановлено пользователем", null) } catch (_: Exception) {}
        }
        pendingPromises.clear()
        stopProcessLocked()
        currentState = "stopped"
      }
    }

    OnDestroy {
      synchronized(lock) {
        generationCounter.incrementAndGet()
        stopProcessLocked()
      }
    }
  }

  private fun resolveAllPending(res: Map<String, Any>) {
    for (p in pendingPromises) {
      try { p.resolve(res) } catch (_: Exception) {}
    }
    pendingPromises.clear()
  }

  private fun rejectAllPending(code: String, msg: String?) {
    for (p in pendingPromises) {
      try { p.reject(code, msg, null) } catch (_: Exception) {}
    }
    pendingPromises.clear()
  }

  private fun isSupported(): Boolean {
    val libFile = File(context.applicationInfo.nativeLibraryDir, "libopera_proxy.so")
    return libFile.exists() && libFile.canExecute()
  }

  private fun findFreePort(): Int {
    return ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
  }

  private fun isPortOpen(port: Int): Boolean {
    return try {
      Socket("127.0.0.1", port).use { true }
    } catch (_: Exception) {
      false
    }
  }

  private fun isProxyReady(port: Int, probeHost: String): Boolean {
    if (!isPortOpen(port)) return false
    return try {
      val parts = probeHost.split(":")
      val host = parts[0]
      val portNum = if (parts.size > 1) parts[1].toInt() else 443

      Socket("127.0.0.1", port).use { socket ->
        socket.soTimeout = 3000
        val out = socket.getOutputStream()
        val inp = socket.getInputStream()
        val req = "CONNECT $host:$portNum HTTP/1.1\r\nHost: $host:$portNum\r\n\r\n"
        out.write(req.toByteArray())
        out.flush()

        val reader = BufferedReader(InputStreamReader(inp))
        val statusLine = reader.readLine() ?: ""
        statusLine.contains("200")
      }
    } catch (_: Exception) {
      false
    }
  }

  private fun addLogLine(line: String) {
    Log.d("OperaProxy", line)
    try {
      sendEvent("onLog", mapOf("line" to line))
    } catch (_: Exception) {}
    synchronized(logBuffer) {
      logBuffer.add(line)
      if (logBuffer.size > 50) logBuffer.removeFirst()
    }
  }

  private fun maskSensitive(line: String): String {
    var res = line
    val lower = res.lowercase()
    if (lower.contains("password") || lower.contains("token") || lower.contains("login") || lower.contains("proxy-authorization")) {
      res = res.replace(Regex("(?i)(password|token|login|proxy-authorization)[:=]\\s*\\S+"), "$1=***")
    }
    return res
  }

  private fun stopProcessLocked() {
    try {
      process?.destroyForcibly()
      process = null
    } catch (_: Exception) {}
  }
}
