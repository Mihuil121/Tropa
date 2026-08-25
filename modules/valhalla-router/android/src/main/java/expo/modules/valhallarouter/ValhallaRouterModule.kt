package expo.modules.valhallarouter

import android.content.Context
import android.os.Build
import com.valhalla.config.ValhallaConfigBuilder
import com.valhalla.valhalla.Valhalla
import com.valhalla.valhalla.ValhallaException
import com.valhalla.valhalla.config.ValhallaConfigManager
import com.valhalla.valhalla.files.ValhallaFile
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.Executors

/**
 * Valhalla прямо в телефоне. Один «движок» на открытый файл дорог: его создание дорогое
 * (читает tar, строит индекс), поэтому держим его, пока не понадобится другой файл.
 * Все вызовы — в одном фоновом потоке: движок не потокобезопасен, а UI не должен ждать.
 */
class ValhallaRouterModule : Module() {
  private val executor = Executors.newSingleThreadExecutor()
  private var engine: Valhalla? = null
  private var enginePath: String? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("ValhallaRouter")

    Function("isSupported") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.O }

    AsyncFunction("route") { tarPath: String, request: String, promise: Promise ->
      executor.execute { answer(promise) { engineFor(tarPath).routeRaw(request) } }
    }

    AsyncFunction("traceAttributes") { tarPath: String, request: String, promise: Promise ->
      executor.execute { answer(promise) { engineFor(tarPath).traceAttributesRaw(request) } }
    }

    AsyncFunction("close") { promise: Promise ->
      executor.execute {
        closeEngine()
        promise.resolve(true)
      }
    }

    OnDestroy {
      executor.execute { closeEngine() }
      executor.shutdown()
    }
  }

  private fun engineFor(tarPath: String): Valhalla {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      throw CodedException("UNSUPPORTED", "Встроенные маршруты работают на Android 8 и новее", null)
    }
    val path = tarPath.removePrefix("file://")
    val current = engine
    if (current != null && enginePath == path) return current
    closeEngine()
    val tar = File(path)
    if (!tar.exists()) throw CodedException("NO_TILES", "Нет файла дорог: $path", null)
    val config = ValhallaConfigBuilder().withTileExtract(tar.absolutePath).build()
    // свой файл конфигурации, чтобы не пересекаться с другими пользователями библиотеки
    val manager = ValhallaConfigManager(context, ValhallaFile(context, "valhalla-tropa.json"))
    val created = Valhalla(context, config, manager)
    engine = created
    enginePath = path
    return created
  }

  private fun closeEngine() {
    try { engine?.close() } catch (_: Throwable) {}
    engine = null
    enginePath = null
  }

  private fun answer(promise: Promise, block: () -> String) {
    try {
      promise.resolve(block())
    } catch (e: CodedException) {
      promise.reject(e)
    } catch (e: ValhallaException) {
      promise.reject(CodedException("VALHALLA", e.message ?: "ошибка Valhalla", e))
    } catch (e: Throwable) {
      // в т.ч. UnsatisfiedLinkError, если нет .so под архитектуру телефона
      promise.reject(CodedException("VALHALLA_NATIVE", e.message ?: e.toString(), e))
    }
  }
}
