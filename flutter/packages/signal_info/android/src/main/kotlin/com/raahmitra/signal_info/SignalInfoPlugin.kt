package com.raahmitra.signal_info

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.MethodChannel.MethodCallHandler
import io.flutter.plugin.common.MethodChannel.Result

class SignalInfoPlugin : FlutterPlugin, MethodCallHandler {
  private lateinit var channel: MethodChannel
  private lateinit var context: Context

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    context = binding.applicationContext
    channel = MethodChannel(binding.binaryMessenger, "com.raahmitra.gpslogger/signal_info")
    channel.setMethodCallHandler(this)
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    channel.setMethodCallHandler(null)
  }

  override fun onMethodCall(call: MethodCall, result: Result) {
    if (call.method != "getSignalInfo") {
      result.notImplemented()
      return
    }
    result.success(readSignalInfo())
  }

  private fun readSignalInfo(): Map<String, Any?> {
    val info = mutableMapOf<String, Any?>(
      "signal_dbm" to null,
      "signal_level" to null,
      "carrier" to null,
      "network_type" to null,
    )

    val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
      ?: return info

    info["carrier"] = tm.networkOperatorName

    val hasPhoneState = ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.READ_PHONE_STATE
    ) == PackageManager.PERMISSION_GRANTED

    if (!hasPhoneState) return info

    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val signalStrength = tm.signalStrength
        if (signalStrength != null) {
          info["signal_dbm"] = signalStrength.cellSignalStrengths.firstOrNull()?.dbm ?: signalStrength.level
          info["signal_level"] = signalStrength.level
        }
      }

      @Suppress("DEPRECATION")
      val networkType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) tm.dataNetworkType else tm.networkType
      info["network_type"] = networkTypeName(networkType)
    } catch (e: SecurityException) {
      // leave defaults
    }

    return info
  }

  private fun networkTypeName(type: Int): String = when (type) {
    TelephonyManager.NETWORK_TYPE_LTE -> "LTE"
    TelephonyManager.NETWORK_TYPE_NR -> "5G"
    TelephonyManager.NETWORK_TYPE_HSPAP -> "HSPA+"
    TelephonyManager.NETWORK_TYPE_HSPA -> "HSPA"
    TelephonyManager.NETWORK_TYPE_UMTS -> "UMTS"
    TelephonyManager.NETWORK_TYPE_EDGE -> "EDGE"
    TelephonyManager.NETWORK_TYPE_GPRS -> "GPRS"
    else -> "UNKNOWN"
  }
}
