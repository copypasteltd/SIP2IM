plugins { kotlin("jvm") }
kotlin { jvmToolchain(17) }
dependencies { testImplementation("junit:junit:4.13.2") }
tasks.test { useJUnit() }

tasks.processTestResources {
    from(rootProject.layout.projectDirectory.dir("../packages/protocol/fixtures")) {
        include("device/call-reject-generation.tsv", "media-v1.tsv")
        into("voipgw-fixtures")
    }
}
