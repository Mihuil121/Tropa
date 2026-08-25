package expo.modules.carsensors

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.location.GnssMeasurementsEvent
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.SystemClock
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.telephony.CellIdentityNr
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.CellSignalStrengthNr
import android.telephony.TelephonyManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Два «датчика», которых нет в стандартных библиотеках:
 *  1) сотовые вышки, которые видит телефон (для определения места без GPS);
 *  2) Bluetooth SPP-соединение с адаптером ELM327 (скорость колёс машины по OBD-II).
 */
class CarSensorsModule : Module() {
  private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
  private var socket: BluetoothSocket? = null
  private var readerThread: Thread? = null
  private val cellExecutor = Executors.newSingleThreadExecutor()
  private val gnssExecutor = Executors.newSingleThreadExecutor()
  private var gnssStatusCb: GnssStatus.Callback? = null
  private var gnssMeasCb: GnssMeasurementsEvent.Callback? = null
  @Volatile private var lastAgc: Double? = null
  private var netListener: LocationListener? = null
  private var lastWifiScanMs = 0L

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CarSensors")
    Events("onObdData", "onObdClosed", "onGnssSignal", "onNetworkLocation")

    // ---------------- Место «по сети» (вышки + Wi‑Fi, без спутников) ----------------

    AsyncFunction("startNetworkLocation") { startNetwork() }
    AsyncFunction("stopNetworkLocation") { stopNetwork(); true }

    // ---------------- Wi‑Fi рядом ----------------

    AsyncFunction("getWifi") {
      val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager?
        ?: return@AsyncFunction emptyList<Map<String, Any>>()
      try {
        // Новый скан не чаще раза в 30 с (Android всё равно ограничивает: 4 скана за 2 минуты)
        val now = SystemClock.elapsedRealtime()
        if (now - lastWifiScanMs > 30_000) {
          lastWifiScanMs = now
          try { wm.startScan() } catch (_: Exception) {} // устарело, но работает (лимит Android)
        }
        val nowUs = SystemClock.elapsedRealtimeNanos() / 1000
        wm.scanResults
          .filter { nowUs - it.timestamp < 120_000_000L } // не старше 2 минут
          .filter { !(it.SSID ?: "").endsWith("_nomap") }  // владелец просил не наносить на карты
          .sortedByDescending { it.level }
          .take(20)
          .map { mapOf<String, Any>("bssid" to (it.BSSID ?: ""), "dbm" to it.level) }
          .filter { (it["bssid"] as String).isNotEmpty() }
      } catch (e: SecurityException) {
        emptyList<Map<String, Any>>()
      }
    }

    // ---------------- Сигнал спутников (против подмены и глушения) ----------------

    AsyncFunction("startGnssMonitor") { startGnss() }
    AsyncFunction("stopGnssMonitor") { stopGnss(); true }

    // ---------------- Сотовые вышки ----------------

    AsyncFunction("getCells") { promise: Promise ->
      try {
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          // Просим свежий снимок, а не закэшированный
          tm.requestCellInfoUpdate(cellExecutor, object : TelephonyManager.CellInfoCallback() {
            override fun onCellInfo(cellInfo: MutableList<CellInfo>) {
              promise.resolve(cellInfo.mapNotNull { toMap(it) })
            }
            override fun onError(errorCode: Int, detail: Throwable?) {
              promise.resolve(safeAllCells(tm))
            }
          })
        } else {
          promise.resolve(safeAllCells(tm))
        }
      } catch (e: SecurityException) {
        promise.reject(CodedException("NO_PERMISSION", "Нет разрешения на геолокацию", e))
      }
    }

    // ---------------- OBD-II через Bluetooth ----------------

    AsyncFunction("listBondedDevices") {
      val adapter = btAdapter() ?: return@AsyncFunction emptyList<Map<String, String>>()
      try {
        adapter.bondedDevices.map { mapOf("name" to (it.name ?: "?"), "address" to it.address) }
      } catch (e: SecurityException) {
        throw CodedException("NO_PERMISSION", "Нет разрешения Bluetooth", e)
      }
    }

    // AsyncFunction выполняется не в UI-потоке, поэтому блокирующий connect() тут допустим
    AsyncFunction("connectObd") { address: String ->
      closeSocket()
      val adapter = btAdapter() ?: throw CodedException("NO_BT", "Bluetooth недоступен", null)
      try {
        adapter.cancelDiscovery()
        val dev = adapter.getRemoteDevice(address)
        var s: BluetoothSocket = dev.createRfcommSocketToServiceRecord(SPP_UUID)
        try {
          s.connect()
        } catch (e: IOException) {
          // Многие дешёвые клоны ELM327 подключаются только «напрямую» на канал 1
          try { s.close() } catch (_: IOException) {}
          val m = dev.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
          s = m.invoke(dev, 1) as BluetoothSocket
          s.connect()
        }
        socket = s
        startReader(s)
        true
      } catch (e: SecurityException) {
        throw CodedException("NO_PERMISSION", "Нет разрешения Bluetooth", e)
      } catch (e: Exception) {
        throw CodedException("CONNECT_FAILED", "Не удалось подключиться к адаптеру: ${e.message}", e)
      }
    }

    AsyncFunction("writeObd") { data: String ->
      val s = socket ?: throw CodedException("NOT_CONNECTED", "Адаптер не подключён", null)
      s.outputStream.write(data.toByteArray(Charsets.US_ASCII))
      s.outputStream.flush()
      true
    }

    AsyncFunction("disconnectObd") {
      closeSocket()
      true
    }

    OnDestroy {
      closeSocket()
      stopGnss()
      stopNetwork()
      cellExecutor.shutdown()
      gnssExecutor.shutdown()
    }
  }

  /**
   * Раз в секунду: сколько спутников в решении, сила их сигнала (C/N0) и разброс,
   * плюс усиление приёмника (AGC), если чип его отдаёт.
   */
  @SuppressLint("MissingPermission")
  @Suppress("DEPRECATION") // старые варианты регистрации и AGC нужны для Android 7–10
  private fun startGnss(): Boolean {
    if (gnssStatusCb != null) return true
    val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val statusCb = object : GnssStatus.Callback() {
      override fun onSatelliteStatusChanged(status: GnssStatus) {
        val cn0 = ArrayList<Double>()
        for (i in 0 until status.satelliteCount) if (status.usedInFix(i)) cn0.add(status.getCn0DbHz(i).toDouble())
        val used = cn0.size
        val mean = if (used > 0) cn0.average() else 0.0
        val std = if (used > 1) Math.sqrt(cn0.sumOf { (it - mean) * (it - mean) } / used) else 0.0
        val top = cn0.sortedDescending().take(4).let { if (it.isEmpty()) 0.0 else it.average() }
        val m = mutableMapOf<String, Any>("used" to used, "total" to status.satelliteCount, "cn0Top" to top, "cn0Std" to std)
        lastAgc?.let { m["agc"] = it }
        sendEvent("onGnssSignal", m)
      }
    }
    val measCb = object : GnssMeasurementsEvent.Callback() {
      override fun onGnssMeasurementsReceived(event: GnssMeasurementsEvent) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val agcs = event.measurements.filter { it.hasAutomaticGainControlLevelDb() }.map { it.automaticGainControlLevelDb }
        lastAgc = if (agcs.isNotEmpty()) agcs.average() else null
      }
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        lm.registerGnssStatusCallback(gnssExecutor, statusCb)
        lm.registerGnssMeasurementsCallback(gnssExecutor, measCb)
      } else {
        val h = Handler(Looper.getMainLooper())
        lm.registerGnssStatusCallback(statusCb, h)
        lm.registerGnssMeasurementsCallback(measCb, h)
      }
    } catch (e: SecurityException) {
      throw CodedException("NO_PERMISSION", "Нет разрешения на геолокацию", e)
    }
    gnssStatusCb = statusCb
    gnssMeasCb = measCb
    return true
  }

  private fun stopGnss() {
    val lm = appContext.reactContext?.getSystemService(Context.LOCATION_SERVICE) as LocationManager? ?: return
    gnssStatusCb?.let { lm.unregisterGnssStatusCallback(it) }
    gnssMeasCb?.let { lm.unregisterGnssMeasurementsCallback(it) }
    gnssStatusCb = null
    gnssMeasCb = null
  }

  @SuppressLint("MissingPermission")
  private fun startNetwork(): Boolean {
    if (netListener != null) return true
    val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    if (!lm.allProviders.contains(LocationManager.NETWORK_PROVIDER)) return false
    val l = object : LocationListener {
      override fun onLocationChanged(loc: Location) {
        val age = (SystemClock.elapsedRealtimeNanos() - loc.elapsedRealtimeNanos) / 1e9
        sendEvent("onNetworkLocation", mapOf(
          "lat" to loc.latitude, "lon" to loc.longitude,
          "accuracy" to (if (loc.hasAccuracy()) loc.accuracy.toDouble() else 1000.0),
          "age" to age,
        ))
      }
      @Deprecated("Deprecated in Java")
      override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
      override fun onProviderEnabled(provider: String) {}
      override fun onProviderDisabled(provider: String) {}
    }
    try {
      lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000L, 0f, l, Looper.getMainLooper())
    } catch (e: SecurityException) {
      throw CodedException("NO_PERMISSION", "Нет разрешения на геолокацию", e)
    } catch (e: IllegalArgumentException) {
      return false
    }
    netListener = l
    return true
  }

  private fun stopNetwork() {
    val lm = appContext.reactContext?.getSystemService(Context.LOCATION_SERVICE) as LocationManager? ?: return
    netListener?.let { lm.removeUpdates(it) }
    netListener = null
  }

  @SuppressLint("MissingPermission")
  private fun btAdapter() =
    (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?)?.adapter

  private fun startReader(s: BluetoothSocket) {
    readerThread = Thread {
      val buf = ByteArray(1024)
      try {
        val input = s.inputStream
        while (!Thread.currentThread().isInterrupted) {
          val n = input.read(buf)
          if (n < 0) break
          if (n > 0) sendEvent("onObdData", mapOf("data" to String(buf, 0, n, Charsets.US_ASCII)))
        }
      } catch (_: IOException) {
      } finally {
        sendEvent("onObdClosed", mapOf<String, Any>())
      }
    }.apply { isDaemon = true; start() }
  }

  private fun closeSocket() {
    readerThread?.interrupt()
    readerThread = null
    try { socket?.close() } catch (_: IOException) {}
    socket = null
  }

  @SuppressLint("MissingPermission")
  private fun safeAllCells(tm: TelephonyManager): List<Map<String, Any>> =
    try { (tm.allCellInfo ?: emptyList()).mapNotNull { toMap(it) } } catch (_: SecurityException) { emptyList() }

  /** Переводит CellInfo в простую карту. Соседние вышки без полного ID пропускаем. */
  @Suppress("DEPRECATION")
  private fun toMap(ci: CellInfo): Map<String, Any>? {
    val unknown = Int.MAX_VALUE
    var radio = ""; var mcc = -1; var mnc = -1; var area = -1; var cid = -1L; var dbm = 0
    var ta = -1 // timing advance: задержка до «своей» LTE-вышки (≈ расстояние)
    when (ci) {
      is CellInfoLte -> {
        val id = ci.cellIdentity
        radio = "LTE"; area = id.tac; cid = id.ci.toLong(); dbm = ci.cellSignalStrength.dbm
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          val t = ci.cellSignalStrength.timingAdvance
          if (t in 0..1282) ta = t
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) { mcc = id.mccString?.toIntOrNull() ?: -1; mnc = id.mncString?.toIntOrNull() ?: -1 }
        else { mcc = id.mcc; mnc = id.mnc }
      }
      is CellInfoGsm -> {
        val id = ci.cellIdentity
        radio = "GSM"; area = id.lac; cid = id.cid.toLong(); dbm = ci.cellSignalStrength.dbm
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) { mcc = id.mccString?.toIntOrNull() ?: -1; mnc = id.mncString?.toIntOrNull() ?: -1 }
        else { mcc = id.mcc; mnc = id.mnc }
      }
      is CellInfoWcdma -> {
        val id = ci.cellIdentity
        radio = "UMTS"; area = id.lac; cid = id.cid.toLong(); dbm = ci.cellSignalStrength.dbm
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) { mcc = id.mccString?.toIntOrNull() ?: -1; mnc = id.mncString?.toIntOrNull() ?: -1 }
        else { mcc = id.mcc; mnc = id.mnc }
      }
      else -> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && ci is CellInfoNr) {
          val id = ci.cellIdentity as CellIdentityNr
          radio = "NR"; area = id.tac; cid = id.nci
          mcc = id.mccString?.toIntOrNull() ?: -1; mnc = id.mncString?.toIntOrNull() ?: -1
          dbm = (ci.cellSignalStrength as CellSignalStrengthNr).dbm
        } else return null
      }
    }
    if (mcc <= 0 || mnc < 0 || area <= 0 || area == unknown || cid <= 0 || cid == unknown.toLong() || cid == Long.MAX_VALUE) return null
    val out = mutableMapOf<String, Any>(
      "radio" to radio, "mcc" to mcc, "mnc" to mnc, "area" to area,
      "cid" to cid.toDouble(), // JS number; NR-идентификаторы до 36 бит, в double помещаются
      "dbm" to dbm, "registered" to ci.isRegistered,
    )
    if (ta >= 0) out["ta"] = ta
    return out
  }
}
