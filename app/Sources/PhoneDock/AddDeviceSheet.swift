import SwiftUI

// Adding a device (design/DESIGN.md › Adding a device): one way in, ＋ Add Device at the top of the sidebar, which
// opens one sheet. Its first step asks the one question people can answer, what kind of device; the second step is
// the form that makes a simulator or emulator, the form that makes a virtual phone, or the steps that connect a
// physical one. The empty state shows the same choices. File › New Simulator or Emulator… (⌘N), New Virtual Phone…
// (⌥⌘N) and Connect a Physical Device… (⇧⌘K) open the second step directly.

/// What the Add Device sheet shows. `AppModel.addDevice` is nil while the sheet is closed.
enum AddDeviceStep: Hashable {
    case choose, simulator, virtualPhone, physical
}

/// The words for kinds of device, in one place so the chooser, sheet titles, sidebar sections, empty state and menus
/// never drift apart. Simulators and emulators are for building and testing apps; a Virtual Phone (the 0.3.0 name,
/// docs/VIRTUAL-PHONES.md) is an Android emulator that presents as a real handset; a Physical Device is your own phone.
enum DeviceWords {
    static let addDevice = "Add Device"
    static let simulator = "Simulator or Emulator"
    static let simulatorDetail = "An iPhone simulator or Android emulator for building and testing your apps."
    static let virtualPhone = "Virtual Phone"
    static let virtualPhoneDetail = "An Android phone with Google Play that apps see as a real Pixel, Galaxy or OnePlus."
    static let physicalDevice = "Physical Device"
    static let physicalDetail = "Your own iPhone or Android phone, connected with a cable or over Wi-Fi."
    /// One line each, for the empty state's narrower guide (the full descriptions stay as accessibility hints).
    static let simulatorShort = "For building and testing your apps."
    static let virtualPhoneShort = "Android with Google Play, seen by apps as a real phone."
    static let physicalShort = "Your own iPhone or Android phone."
    static let newSimulator = "New Simulator or Emulator"
    static let newVirtualPhone = "New Virtual Phone"
    static let connectPhysicalDevice = "Connect a Physical Device"
    static let simulators = "Simulators & Emulators"
    static let virtualPhones = "Virtual Phones"
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
            case .simulator: CreateDeviceSheet(onBack: back)
            case .virtualPhone: VirtualPhoneSheet(onBack: back)
            case .physical: ConnectPhoneSheet(onBack: back)
            }
        }
        .onChange(of: model.addDevice, initial: true) { _, step in if let step { shown = step } }
    }

    private func back() { model.addDevice = .choose }
}

/// Step one: what kind of device.
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

/// The three choices, as large buttons: in the chooser and in the empty state's guide (`compact`).
struct AddDeviceOptions: View {
    @Environment(AppModel.self) private var model
    var compact = false

    var body: some View {
        VStack(spacing: compact ? Theme.Space.s : Theme.Space.m) {
            // Making a device needs the service; connecting a phone starts with steps on the phone.
            option(.simulator, symbol: "macbook.and.iphone", title: DeviceWords.simulator,
                   detail: DeviceWords.simulatorDetail, short: DeviceWords.simulatorShort)
                .disabled(!model.connection.isConnected)
            option(.virtualPhone, symbol: "smartphone", title: DeviceWords.virtualPhone,
                   detail: DeviceWords.virtualPhoneDetail, short: DeviceWords.virtualPhoneShort)
                .disabled(!model.connection.isConnected)
            option(.physical, symbol: "iphone.radiowaves.left.and.right", title: DeviceWords.physicalDevice,
                   detail: DeviceWords.physicalDetail, short: DeviceWords.physicalShort)
        }
    }

    private func option(_ step: AddDeviceStep, symbol: String, title: String, detail: String, short: String) -> some View {
        Button { model.addDevice = step } label: {
            HStack(spacing: compact ? Theme.Space.m : Theme.Space.l) {
                Image(systemName: symbol)
                    .font(.system(size: compact ? 17 : 22))
                    .foregroundStyle(Theme.Accent.text)
                    .frame(width: compact ? 26 : 32)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                    Text(title).font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary)
                    Text(compact ? short : detail)
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
            .help("Add a simulator, emulator, virtual phone or your own phone")
            .testAnchor(DeviceWords.addDevice)
    }
}
