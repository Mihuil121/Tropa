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

class OperaProxyModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "ReactContext is null" }

  private var process: Process? = null
  private var currentPort: Int = 0
  private var currentCountry: String = "EU"
  private var currentState: String = "stopped" // stopped, starting, ready, failed
  private var lastError: String? = null

  private var restartCount = 0
  private var lastRestartTime = 0L
  private val executor = Executors.newCachedThreadPool()

  override fun definition() = ModuleDefinition {
    Name("OperaProxy")

    Function("isSupported") {
      isSupported()
    }

    Function("status") {
      mapOf(
        "state" to currentState,
        "port" to if (currentPort > 0) currentPort else null,
        "country" to currentCountry,
        "lastError" to lastError
      )
    }

    AsyncFunction("start") { options: Map<String, Any?>?, promise: Promise ->
      executor.execute {
        try {
          if (!isSupported()) {
            promise.reject("ERR_NOT_SUPPORTED", "opera-proxy бинарник не найден в nativeLibraryDir", null)
            return@execute
          }

          if (currentState == "ready" && isPortOpen(currentPort)) {
            promise.resolve(mapOf("port" to currentPort))
            return@execute
          }

          stopProcess()
          currentState = "starting"
          lastError = null

          val country = (options?.get("country") as? String) ?: "EU"
          val serverSelection = (options?.get("country") as? String) ?: "first"
          val initRetries = (options?.get("initRetries") as? Number)?.toInt() ?: 3
          val timeout = (options?.get("timeout") as? String) ?: "10s"
          val apiProxyFile = options?.get("apiProxyFile") as? String

          currentCountry = country
          val freePort = findFreePort()
          currentPort = freePort

          val libFile = File(context.applicationInfo.nativeLibraryDir, "libopera_proxy.so")
          val cmd = mutableListOf(
            libFile.absolutePath,
            "-bind-address", "127.0.0.1:$freePort",
            "-country", country,
            "-server-selection", serverSelection,
            "-init-retries", initRetries.toString(),
            "-timeout", timeout
          )

          if (!apiProxyFile.isNullOrBlank()) {
            cmd.add("-api-proxy-file")
            cmd.add(apiProxyFile)
          }

          Log.d("OperaProxy", "Запуск: ${cmd.joinToString(" ")}")
          val pb = ProcessBuilder(cmd)
          pb.directory(context.filesDir)
          val proc = pb.start()
          process = proc

          // Чтение логов в отдельном потоке
          executor.execute {
            try {
              val reader = BufferedReader(InputStreamReader(proc.inputStream))
              var line: String?
              while (reader.readLine().also { line = it } != null) {
                val l = line ?: break
                if (!l.contains("password", ignoreCase = true) && !l.contains("token", ignoreCase = true)) {
                  Log.d("OperaProxy", l)
                }
              }
            } catch (_: Exception) {}
          }

          executor.execute {
            try {
              val reader = BufferedReader(InputStreamReader(proc.errorStream))
              var line: String?
              while (reader.readLine().also { line = it } != null) {
                val l = line ?: break
                Log.e("OperaProxy", l)
              }
            } catch (_: Exception) {}
          }

          // Проверка готовности портом и CONNECT
          val startTime = System.currentTimeMillis()
          var ready = false
          while (System.currentTimeMillis() - startTime < 25000) {
            if (!proc.isAlive) {
              val exitCode = try { proc.exitValue() } catch (_: Exception) { -1 }
              lastError = "Процесс завершился с кодом $exitCode"
              currentState = "failed"
              promise.reject("ERR_START_FAILED", lastError, null)
              return@execute
            }

            if (isPortOpen(freePort)) {
              ready = true
              break
            }
            Thread.sleep(500)
          }

          if (ready) {
            currentState = "ready"
            restartCount = 0
            promise.resolve(mapOf("port" to freePort))
          } else {
            stopProcess()
            currentState = "failed"
            lastError = "Таймаут старта прокси (25 с)"
            promise.reject("ERR_TIMEOUT", lastError, null)
          }
        } catch (e: Exception) {
          stopProcess()
          currentState = "failed"
          lastError = e.message
          promise.reject("ERR_START_FAILED", e.message, e)
        }
      }
    }

    Function("stop") {
      stopProcess()
      currentState = "stopped"
    }

    OnDestroy {
      stopProcess()
    }
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
      Socket("127.0.0.1", port).use { socket ->
        socket.soTimeout = 2000
        true
      }
    } catch (_: Exception) {
      false
    }
  }

  private fun stopProcess() {
    try {
      process?.destroy()
      process = null
    } catch (_: Exception) {}
  }
}
