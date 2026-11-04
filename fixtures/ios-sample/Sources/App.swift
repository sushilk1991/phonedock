import SwiftUI

@main
struct PhoneDockSampleApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var name = ""
    @State private var greeting = ""
    @State private var notify = false
    @State private var password = ""
    @State private var signedIn = false

    var body: some View {
        NavigationStack {
            List {
                // A password only a person should type (handoff demos and tests). First, so the keyboard never covers it.
                Section("Account") {
                    SecureField("Password", text: $password)
                        .onSubmit { signedIn = !password.isEmpty }
                        .accessibilityIdentifier("passwordField")
                    Button("Sign in") { signedIn = !password.isEmpty }
                        .accessibilityIdentifier("signInButton")
                    Text(signedIn ? "Signed in" : "Not signed in")
                        .accessibilityIdentifier("signInStatus")
                }
                Section("Greeter") {
                    TextField("Your name", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("nameField")
                    Button("Greet") {
                        greeting = "Hello, \(name.isEmpty ? "World" : name)!"
                    }
                    .accessibilityIdentifier("greetButton")
                    Text(greeting.isEmpty ? " " : greeting)
                        .accessibilityIdentifier("greetingLabel")
                    Toggle("Notifications", isOn: $notify)
                        .accessibilityIdentifier("notifyToggle")
                    Text(notify ? "Notifications on" : "Notifications off")
                        .accessibilityIdentifier("notifyStatus")
                }
                Section("Rows") {
                    ForEach(1...20, id: \.self) { i in
                        Text("Row \(i)")
                            .accessibilityIdentifier("row\(i)")
                    }
                }
            }
            .navigationTitle("PhoneDock Sample")
        }
    }
}
