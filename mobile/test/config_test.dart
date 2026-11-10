import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/config.dart';
import 'package:pacetara/core/http/api_client.dart';

void main() {
  group('AppConfig.validateUrl', () {
    test('menerima domain https', () {
      expect(() => AppConfig.validateUrl('https://pace-api.bimacreative.tech', release: true), returnsNormally);
    });

    test('menolak http biasa', () {
      expect(() => AppConfig.validateUrl('http://pace-api.bimacreative.tech', release: false), throwsStateError);
    });

    test('menolak alamat IP di build rilis', () {
      expect(() => AppConfig.validateUrl('https://203.0.113.10', release: true), throwsStateError);
    });

    test('bawaan memakai https', () {
      expect(AppConfig.apiBaseUrl, startsWith('https://'));
    });
  });

  test('ApiHealth.fromJson', () {
    final h = ApiHealth.fromJson({'status': 'ok', 'database': 'ok', 'redis': 'down'});
    expect(h.status, 'ok');
    expect(h.redis, 'down');
  });
}
