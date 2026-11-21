plugins { id("com.android.application"); kotlin("android") }
android {
    namespace = "io.voipgw.gateway"
    compileSdk = 35
    defaultConfig {
        applicationId = "io.voipgw.gateway"
        minSdk = 19
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        multiDexEnabled = true
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation(project(":protocol"))
    implementation("com.squareup.okhttp3:okhttp:3.12.13")
    implementation("androidx.multidex:multidex:2.0.1")
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
    testImplementation("junit:junit:4.13.2")
}
