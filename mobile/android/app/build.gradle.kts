import java.io.FileInputStream
import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Kunci tanda tangan rilis: dari environment (CI) atau android/key.properties (lokal, tidak di-commit).
val keyProps = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) FileInputStream(f).use { load(it) }
}
fun signing(prop: String, env: String): String? = System.getenv(env)?.takeIf { it.isNotEmpty() } ?: keyProps.getProperty(prop)
val releaseStore = signing("storeFile", "PACETARA_KEYSTORE_PATH")

// ID aplikasi AdMob (modul 2.7) untuk meta-data APPLICATION_ID di manifest. Sumber: --dart-define=ADMOB_APP_ID
// (Flutter meneruskan semua dart-define ke Gradle sebagai properti `dart-defines`, base64 per entri), lalu env
// ADMOB_APP_ID (CI), lalu ID aplikasi uji resmi Google agar build tanpa akun AdMob tetap jalan. Tanpa ID unit
// iklan, build rilis tidak menampilkan iklan apa pun walau memakai ID uji ini.
val dartDefines: Map<String, String> = (project.findProperty("dart-defines") as String?)
    ?.split(",")
    ?.mapNotNull { entry ->
        runCatching { String(Base64.getDecoder().decode(entry), Charsets.UTF_8) }.getOrNull()
    }
    ?.filter { it.contains("=") }
    ?.associate { it.substringBefore("=") to it.substringAfter("=") }
    ?: emptyMap()
val admobTestAppId = "ca-app-pub-3940256099942544~3347511713"
val admobAppId: String = (dartDefines["ADMOB_APP_ID"]?.trim()?.takeIf { it.isNotEmpty() }
    ?: System.getenv("ADMOB_APP_ID")?.trim()?.takeIf { it.isNotEmpty() }
    ?: admobTestAppId).also {
    if (!Regex("^ca-app-pub-[0-9]{10,20}~[0-9]{6,12}$").matches(it)) {
        throw GradleException("ADMOB_APP_ID tidak valid (format ca-app-pub-<16 digit>~<10 digit>)")
    }
}

// Host App Links untuk tautan undangan https://<host>/j/KODE (--dart-define=APP_LINKS_HOST, lalu env). Kosong =
// host `.invalid` (RFC 2606) yang tidak pernah cocok, sehingga build tanpa domain tidak mengklaim tautan apa pun.
val appLinksHost: String = (dartDefines["APP_LINKS_HOST"]?.trim()?.takeIf { it.isNotEmpty() }
    ?: System.getenv("APP_LINKS_HOST")?.trim()?.takeIf { it.isNotEmpty() }
    ?: "applinks.invalid").also {
    if (!Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$").matches(it)) {
        throw GradleException("APP_LINKS_HOST tidak valid (nama host saja, tanpa skema/path)")
    }
}

android {
    namespace = "tech.bimacreative.pacetara"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "tech.bimacreative.pacetara"
        // Health Connect (plugin `health`, modul 2.3) butuh Android 8.0 / API 26.
        minSdk = maxOf(26, flutter.minSdkVersion)
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["admobAppId"] = admobAppId
        manifestPlaceholders["appLinksHost"] = appLinksHost
    }

    signingConfigs {
        if (releaseStore != null) {
            create("release") {
                storeFile = file(releaseStore)
                storePassword = signing("storePassword", "PACETARA_KEYSTORE_PASSWORD")
                keyAlias = signing("keyAlias", "PACETARA_KEY_ALIAS")
                keyPassword = signing("keyPassword", "PACETARA_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // Tanpa kunci rilis (mis. build lokal cepat), pakai kunci debug agar tetap bisa dipasang.
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
