package tech.bimacreative.pacetara

import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// FlutterFragmentActivity: plugin `health` meminta izin Health Connect lewat registerForActivityResult.
class MainActivity : FlutterFragmentActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Aksi intent yang membuka aplikasi. Health Connect membuka aplikasi dengan
        // ACTION_SHOW_PERMISSIONS_RATIONALE / VIEW_PERMISSION_USAGE agar penjelasan izin ditampilkan.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "pacetara/launch").setMethodCallHandler { call, result ->
            if (call.method == "launchAction") result.success(intent?.action) else result.notImplemented()
        }
    }
}
