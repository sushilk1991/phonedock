// Public entry of the PhoneDock TypeScript SDK.
export {
  PhoneDockClient, PhoneDockApiError, DEFAULT_PORT, phonedockHome, readDaemonInfo, resolveDaemonEntry, daemonLogFile, imageSize, tapMeta,
} from './client.ts';
// Flows: parse / write / convert (src/core/flow.ts) and run them (src/core/flow-runner.ts).
export { parseFlow, validateFlow, parseStep, stepOut, writeFlow, describeStep, toMaestro, flowFromLog, FlowError } from '../core/flow.ts';
export type { Flow, Step, Selector, Point } from '../core/flow.ts';
export { runFlow, runFlowFiles, collectFlowFiles, junitXml } from '../core/flow-runner.ts';
export type { FlowClient, FlowResult, StepResult, SuiteResult, RunOptions } from '../core/flow-runner.ts';
export type {
  ClientOptions, Job, BackendInfo, HealthInfo, DaemonInfo, ScreenshotResult, ActionRecord, PhoneDockEvent, WaitOptions,
  FindOptions, FindResult, WaitForOptions, WaitForResult, FillOptions, FillResult, FocusResult, CrashText, RecordingStatus, RecordingResult, AppDataEntry,
  TraceStartOptions, TraceStartResult, TraceStopOptions, TraceStopResult, TraceStatus, TraceListEntry,
  TraceSummary, TraceMetrics, TraceHangs, TraceHotspot, TraceFrames, TraceComparison,
  ScrollToOptions, ScrollToResult, SaveFlowOptions, SaveFlowResult, SystemGesture, GestureResult, BackResult, PromptResult, AlertActionInput, AlertResult,
  CrashReport, ElementMatch, Handoff, HandoffState, PromptButton, PromptKind, SystemPrompt, TapSelector,
  AppInfo, BootOptions, Device, DeviceSpec, ExecResult, HardwareProfile, InputAction, KeyName, Lease,
  OsImage, Platform, ScreenInfo, Snapshot, UiTree, UiElement, Bounds, Availability, Capability, DeviceKind, DeviceState,
} from './client.ts';
