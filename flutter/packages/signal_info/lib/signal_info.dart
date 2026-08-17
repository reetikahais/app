import 'package:flutter/services.dart';

class SignalInfo {
  const SignalInfo({this.signalDbm, this.signalLevel, this.carrier, this.networkType});

  final int? signalDbm;
  final int? signalLevel;
  final String? carrier;
  final String? networkType;

  static const empty = SignalInfo();
}

const MethodChannel _channel = MethodChannel('com.raahmitra.gpslogger/signal_info');

Future<SignalInfo> getSignalInfo() async {
  try {
    final result = await _channel.invokeMapMethod<String, Object?>('getSignalInfo');
    if (result == null) return SignalInfo.empty;
    return SignalInfo(
      signalDbm: result['signal_dbm'] as int?,
      signalLevel: result['signal_level'] as int?,
      carrier: result['carrier'] as String?,
      networkType: result['network_type'] as String?,
    );
  } on PlatformException {
    return SignalInfo.empty;
  }
}
