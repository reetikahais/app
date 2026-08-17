const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MODULE_KT = `package __PACKAGE__

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class SignalInfoModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "SignalInfo"

  @ReactMethod
  fun getSignalInfo(promise: Promise) {
    val result = Arguments.createMap()
    result.putNull("signal_dbm")
    result.putNull("signal_level")
    result.putNull("carrier")
    result.putNull("network_type")

    try {
      val tm = reactApplicationContext.getSystemService(TelephonyManager::class.java)
      if (tm == null) {
        promise.resolve(result)
        return
      }

      result.putString("carrier", tm.networkOperatorName)

      val hasPhoneState = ContextCompat.checkSelfPermission(
        reactApplicationContext,
        Manifest.permission.READ_PHONE_STATE
      ) == PackageManager.PERMISSION_GRANTED

      if (hasPhoneState) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          val signalStrength = tm.signalStrength
          if (signalStrength != null) {
            result.putInt("signal_dbm", signalStrength.cellSignalStrengths.firstOrNull()?.dbm ?: signalStrength.level)
            result.putInt("signal_level", signalStrength.level)
          }
        }

        @Suppress("DEPRECATION")
        val networkType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) tm.dataNetworkType else tm.networkType
        result.putString("network_type", networkTypeName(networkType))
      }

      promise.resolve(result)
    } catch (e: SecurityException) {
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("signal_info_error", e.message, e)
    }
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
`;

const PACKAGE_KT = `package __PACKAGE__

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class SignalInfoPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    return listOf(SignalInfoModule(reactContext))
  }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
    return emptyList()
  }
}
`;

function withSignalInfoNativeFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const packageName = config.android.package;
      const packagePath = packageName.split('.').join('/');
      const dir = path.join(
        config.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', packagePath
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SignalInfoModule.kt'), MODULE_KT.replaceAll('__PACKAGE__', packageName));
      fs.writeFileSync(path.join(dir, 'SignalInfoPackage.kt'), PACKAGE_KT.replaceAll('__PACKAGE__', packageName));
      return config;
    },
  ]);
}

function withSignalInfoRegistration(config) {
  return withMainApplication(config, (config) => {
    let contents = config.modResults.contents;

    if (!contents.includes('SignalInfoPackage()')) {
      const applyTarget = /PackageList\(this\)\.packages\s*\.apply\s*\{([^}]*)\}/;
      const bareTarget = 'PackageList(this).packages';

      if (applyTarget.test(contents)) {
        contents = contents.replace(applyTarget, (match, inner) =>
          `PackageList(this).packages.apply {${inner}\n          add(SignalInfoPackage())\n        }`
        );
      } else if (contents.includes(bareTarget)) {
        contents = contents.replace(
          bareTarget,
          `${bareTarget}.apply {\n          add(SignalInfoPackage())\n        }`
        );
      }
    }

    config.modResults.contents = contents;
    return config;
  });
}

module.exports = function withSignalInfo(config) {
  config = withSignalInfoNativeFiles(config);
  config = withSignalInfoRegistration(config);
  return config;
};
