import java.io.FileInputStream
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
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
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
