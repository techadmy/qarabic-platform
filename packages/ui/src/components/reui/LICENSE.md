# ReUI Event Calendar (vendored)

The files in this folder come from **ReUI** (https://reui.io), the Event Calendar component in its
Radix flavour (`radix-nova` registry style). They were copied from Ahmed's Janna project
(`apps/web/src/components/reui`), which matches the official registry item except for import paths
(decision D149, 2026-11-15). ReUI is published under the MIT licence.

Local changes: import aliases (`@qarabic/ui/...`), lucide icons in place of ReUI's
`IconPlaceholder`, and the event colour presets mapped to our tokens (`--chart-*`,
`--status-*-emphasis`); TypeScript non-null assertions for our `noUncheckedIndexedAccess`; and
logical `insetInlineStart` instead of `left` for the now-indicator and overlapping events, prev/next chevrons that turn in RTL, and the resource view calling `renderDayColumnBackground` per resource (with `resourceId`).

## MIT License

Copyright (c) the ReUI authors (https://reui.io)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
