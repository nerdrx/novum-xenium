plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

val fcmCompileOnly = providers.gradleProperty("android.fcmCompileOnly").orNull == "true"
val enableFcm = providers.gradleProperty("android.fcm").orNull == "true" || fcmCompileOnly
if (fcmCompileOnly && gradle.startParameter.taskNames.any {
        it.substringAfterLast(':').startsWithAny("assemble", "build", "bundle", "install", "package")
    }) {
    throw GradleException("android.fcmCompileOnly validates sources only; provide google-services.json for an installable APK.")
}
if (enableFcm && !fcmCompileOnly) {
    require(file("google-services.json").isFile) {
        "FCM requires android/app/google-services.json. See android/README.md."
    }
    pluginManager.apply("com.google.gms.google-services")
}

fun String.startsWithAny(vararg prefixes: String): Boolean = prefixes.any { startsWith(it, ignoreCase = true) }

android {
    namespace = "com.novumxenium.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.novumxenium.app"
        minSdk = 26
        targetSdk = 35
        testInstrumentationRunner = "com.novumxenium.app.ConnectionHeaderTest"
        versionCode = 4
        versionName = "0.1.5"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    defaultConfig { buildConfigField("boolean", "FCM_ENABLED", enableFcm.toString()) }
    if (enableFcm) {
        flavorDimensions += "push"
        productFlavors {
            create("fcm") {
                dimension = "push"
                buildConfigField("boolean", "FCM_ENABLED", "true")
            }
        }
    }
    buildTypes { release { isMinifyEnabled = false } }
}
dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation(files("libs/novumbridge.aar"))
    testImplementation("junit:junit:4.13.2")
    if (enableFcm) {
        implementation(platform("com.google.firebase:firebase-bom:34.19.0"))
        implementation("com.google.firebase:firebase-messaging")
    }
}
