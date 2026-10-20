---
id: P-vendor-as-shipped
version: 1
status: accepted
type: ban
applies:
  paths: [vendor/**]
  when: ""
export: true
---

## Rule
Never change anything under vendor/: it is a vendored copy, kept exactly as upstream ships it.

## Why
vendor/ is upstream code: a fix there is lost at the next update, so fixes go upstream or into our own code.

## How to check
- git diff --quiet <base> -- vendor/
