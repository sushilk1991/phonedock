import SwiftUI

// Adding a device (design/DESIGN.md › Adding a device): one way in, ＋ Add Device at the top of the sidebar, which
// opens one sheet. Its first step asks the one question people can answer, virtual or physical; the second step is
// the form that makes a virtual device or the steps that connect a physical one. The empty state shows the same two
// choices. File › New Virtual Device… (⌘N) and Connect a Physical Device… (⇧⌘K) open the second step directly.

/// What the Add Device sheet shows. `AppModel.addDevice` is nil while the sheet is closed.
enum AddDeviceStep: Hashable {
    case choose, virtual, physical
}

/// The words for kinds of device, in one place so the chooser, sheet titles, sidebar sections, empty state and menus
/// never drift apart. Android Studio uses the same pair ("Virtual", "Physical"); the descriptions name what people
/// know (Simulator, Emulator, iPhone, Android phone).
enum DeviceWords {
    static let addDevice = "Add Device"
    static let virtualDevice = "Virtual Device"
    static let virtualDetail = "An iPhone simulator or Android emulator that runs on this Mac."
    static let physicalDevice = "Physical Device"
    static let physicalDetail = "Your own iPhone or Android phone, connected with a cable or over Wi-Fi."
    static let newVirtualDevice = "New Virtual Device"
    static let connectPhysicalDevice = "Connect a Physical Device"
    static let virtualDevices = "Virtual Devices"
    static let physicalDevices = "Physical Devices"
    static let discovered = "From Xcode & Android Studio"
    static let discoveredHelp = "Simulators and emulators made in Xcode or Android Studio. The ones in use are listed; the rest are a click away."
}

/// The one Add Device sheet. The step can change while it's open (chooser → form → Back), so the sheet is presented
/// once and switches its content; it never closes and reopens between steps.
struct AddDeviceSheet: View {
    @Environment(AppModel.self) private var model
    /// The last step shown, kept while the sheet animates closed (when `model.addDevice` is already nil) so the
    /// chooser doesn't flash in its place.
    @State private var shown: AddDeviceStep?

    var body: some View {
        Group {
            switch shown ?? model.addDevice ?? .choose {
            case .choose: AddDeviceChooser()
            case .virtual: CreateDeviceSheet(onBack: back)
            case .physical: ConnectPhoneSheet(onBack: back)
            }
        }
        .onChange(of: model.addDevice, initial: true) { _, step in if let step { shown = step } }
    }

    private func back() { model.addDevice = .choose }
}

/// Step one: virtual or physical.
struct AddDeviceChooser: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetTitle(title: DeviceWords.addDevice)
            Text("Your agents can use it as soon as it’s ready.")
                .font(Theme.Fonts.callout)
                .foregroundStyle(Theme.Ink.secondary)
                .padding(.top, Theme.Space.xs)
            AddDeviceOptions()
                .padding(.top, Theme.Space.xl)
            // The sidebar's From Xcode & Android Studio section, explained where people decide how to add one.
            Label {
                Text("Simulators and emulators you made in Xcode or Android Studio show up in the sidebar on their own.")
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "info.circle")
            }
            .font(Theme.Fonts.callout)
            .foregroundStyle(Theme.Ink.secondary)
            .padding(.top, Theme.Space.l)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .testAnchor("Cancel Add Device")
            }
            .padding(.top, Theme.Space.xl)
        }
        .padding(Theme.Space.xxl)
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
        .testAnchor("add-device-chooser")
    }
}

/// The two choices, as large buttons: in the chooser and in the empty state's guide (`compact`).
struct AddDeviceOptions: View {
    @Environment(AppModel.self) private var model
    var compact = false

    var body: some View {
        VStack(spacing: compact ? Theme.Space.s : Theme.Space.m) {
            option(.virtual, symbol: "macbook.and.iphone",
                   title: DeviceWords.virtualDevice, detail: DeviceWords.virtualDetail)
                // Making a device needs the service; connecting a phone starts with steps on the phone.
                .disabled(!model.connection.isConnected)
            option(.physical, symbol: "iphone.radiowaves.left.and.right",
                   title: DeviceWords.physicalDevice, detail: DeviceWords.physicalDetail)
        }
    }

    private func option(_ step: AddDeviceStep, symbol: String, title: String, detail: String) -> some View {
        Button { model.addDevice = step } label: {
            HStack(spacing: compact ? Theme.Space.m : Theme.Space.l) {
                Image(systemName: symbol)
                    .font(.system(size: compact ? 17 : 22))
                    .foregroundStyle(Theme.Accent.text)
                    .frame(width: compact ? 26 : 32)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                    Text(title).font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary)
                    Text(detail)
                        .font(Theme.Fonts.callout)
                        .foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: Theme.Space.m)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Ink.tertiary)
                    .accessibilityHidden(true)
            }
        }
        .buttonStyle(AddDeviceOptionStyle(compact: compact))
        .accessibilityLabel(title)
        .accessibilityHint(detail)
        .testAnchor(title)
    }
}

/// A choice card: `Surface.card` with the `Line.card` outline and card radius, the outline in the accent while the
/// pointer is over it.
private struct AddDeviceOptionStyle: ButtonStyle {
    var compact: Bool

    func makeBody(configuration: Configuration) -> some View {
        Card(configuration: configuration, compact: compact)
    }

    private struct Card: View {
        let configuration: Configuration
        let compact: Bool
        @Environment(\.isEnabled) private var enabled
        @State private var hovering = false

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
            configuration.label
                .padding(.horizontal, compact ? Theme.Space.m : Theme.Space.l)
                .padding(.vertical, compact ? Theme.Space.m : Theme.Space.l)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.Surface.card, in: shape)
                .overlay(shape.strokeBorder(hovering ? Theme.Accent.fill : Theme.Line.card, lineWidth: 1))
                .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.5)
                .contentShape(shape)
                .onHover { hovering = $0 && enabled }
                .animation(Theme.Motion.quick, value: hovering)
        }
    }
}

/// A sheet's title. With `onBack` (the second step of Add Device) a Back chevron sits before it (⌘[); `backDisabled`
/// keeps it in place but inactive while the step has work in flight.
struct SheetTitle: View {
    let title: String
    var onBack: (() -> Void)? = nil
    var backDisabled = false

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            if let onBack {
                Button(action: onBack) {
                    Image(systemName: "chevron.backward")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .foregroundStyle(backDisabled ? Theme.Ink.tertiary : Theme.Ink.secondary)
                .keyboardShortcut("[", modifiers: .command)
                .disabled(backDisabled)
                .help(backDisabled ? "Available when the download finishes" : "Back (⌘[)")
                .accessibilityLabel("Back")
                .testAnchor("Back")
                .padding(.leading, -Theme.Space.xs)   // the chevron's own inset; its glyph lines up with the margin
            }
            Text(title)
                .font(Theme.Fonts.title)
                .foregroundStyle(Theme.Ink.primary)
                .accessibilityAddTraits(.isHeader)
        }
    }
}

/// ＋ Add Device: at the top of the sidebar (its toolbar band, beside the sidebar toggle), or in the main toolbar
/// while the sidebar is hidden.
struct AddDeviceButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Button { model.addDevice = .choose } label: { Label(DeviceWords.addDevice, systemImage: "plus") }
            .help("Add a virtual or physical device")
            .testAnchor(DeviceWords.addDevice)
    }
}
