package tech.bimacreative.pacetara

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// FlutterFragmentActivity: plugin `health` meminta izin Health Connect lewat registerForActivityResult.
class MainActivity : FlutterFragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        sanitizeDeepLink(intent)
        super.onCreate(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        sanitizeDeepLink(intent)
        super.onNewIntent(intent)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Aksi intent yang membuka aplikasi. Health Connect membuka aplikasi dengan
        // ACTION_SHOW_PERMISSIONS_RATIONALE / VIEW_PERMISSION_USAGE agar penjelasan izin ditampilkan.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "pacetara/launch").setMethodCallHandler { call, result ->
            if (call.method == "launchAction") result.success(intent?.action) else result.notImplemented()
        }
    }

    /**
     * Deep link Flutter meneruskan path + query intent ke router. Agar tautan dari luar tidak bisa membuka
     * layar sembarang (mis. `pacetara://app/imports/../communities/join?code=..`), intent VIEW dibangun ulang
     * hanya dari bagian yang diizinkan: `pacetara://app/imports` dengan `provider` dan `complete` tervalidasi.
     */
    private fun sanitizeDeepLink(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val data = intent.data ?: return
        if (data.scheme == "https") {
            // App Links undangan: hanya /j/<kode 8 karakter>; selain itu dibuka sebagai beranda.
            val m = INVITE_PATH.matchEntire(data.path ?: "")
            intent.data = Uri.Builder().scheme("https").authority(data.authority).path(if (m != null) "/j/${m.groupValues[1]}" else "/").build()
            return
        }
        if (data.scheme != "pacetara") return
        val safe = Uri.Builder().scheme("pacetara").authority("app").path("/imports")
        if (data.host == "app" && data.path == "/imports") {
            val provider = data.getQueryParameter("provider")
            val code = data.getQueryParameter("complete")
            if ((provider == "garmin" || provider == "strava") && code != null && COMPLETE_CODE.matches(code)) {
                safe.appendQueryParameter("provider", provider).appendQueryParameter("complete", code)
            }
        }
        intent.data = safe.build()
    }

    private companion object {
        val COMPLETE_CODE = Regex("^[A-Za-z0-9_-]{20,100}$")
        val INVITE_PATH = Regex("^/j/([A-Za-z2-9]{8})$")
    }
}
