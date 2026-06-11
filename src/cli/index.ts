#!/usr/bin/env bun
import { doctor, formatDoctorChecks } from "./doctor"
import { install } from "./install"

const command = process.argv[2] ?? "help"

if (command === "install") {
  const written = install()
  console.log(`Installed Superpowers Controller for OpenCode:\n${written.join("\n")}`)
} else if (command === "doctor") {
  const checks = doctor()
  console.log(formatDoctorChecks(checks))
  if (checks.some((check) => !check.ok)) process.exitCode = 1
} else {
  console.log(`Usage:
  opencode-superpowers-controller install
  opencode-superpowers-controller doctor`)
}
