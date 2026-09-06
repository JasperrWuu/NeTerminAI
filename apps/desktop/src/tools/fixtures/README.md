# CFG export regression fixtures

Source: the four user-supplied NetOpsTools exports dated 2026-09-06.
The sample password/community has been replaced with `Fixture@123`; no user credentials should be added here.
Tests compare the full generated text, changing the product heading, line endings and the explicitly requested management-route `return` / `system-view` preamble.

These are compatibility fixtures, not evidence that every command is supported or secure on every FW/AR firmware.
The preset intentionally retains the fixed `90.0.0.0/8` route, /24 gateway derivation,
default VPN unbinding in no-VPN mode, pre-existing VPN assumption in VPN mode,
and Firewall Log / security-policy sections even for AR, matching the source exactly.
Each optional feature is now independently selected. Base management configuration is mandatory.
The engineering UI deliberately has no additional risk-acceptance gate; generated text is available before copy/send.
Multiple AAA users extend the source's single user rule; SNMP uses the first user's password.

Run `npm run test:cfg --workspace=@neterminai/desktop` from the repository root.
Physical device command acceptance, prompts, permissions and disconnects during management changes require manual verification.
Terminal dispatch acknowledges queue admission only, not execution on a device.
