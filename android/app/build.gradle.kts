plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

android {
    namespace = "com.novumxenium.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.novumxenium.app"
        minSdk = 26
        targetSdk = 35
        testInstrumentationRunner = "com.novumxenium.app.ConnectionHeaderTest"
        versionCode = 2
        versionName = "0.1.3"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    buildTypes { release { isMinifyEnabled = false } }
}
dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation(files("libs/novumbridge.aar"))
    testImplementation("junit:junit:4.13.2")
}
