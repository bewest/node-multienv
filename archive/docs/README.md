# Archived Documentation

## Overview

This directory contains documentation that has been superseded by newer implementation details or consolidated into other documents.

## Archived Files

### IMPLEMENTATION-SUMMARY.md

**Created**: October 24, 2025  
**Archived**: October 27, 2025

**Issue**: Describes monolithic composite architecture (ConfigMap → all resources)

**Why Archived**:
- Gen 4 shipped with **two-composite architecture** (storage + compute separation)
- Document describes single `/composite/sync` endpoint
- Actual implementation uses:
  - `/storage-composite/sync` (Secret → MongoDB + Migration)
  - `/compute-composite/sync` (ConfigMap → Nightscout + CDC)
- Validation results are for monolithic approach that was never shipped

**See Instead**:
- `docs/TWO-COMPOSITE-ARCHITECTURE.md` - Current Gen 4 implementation
- `archive/monolithic-composite/README.md` - Why monolithic wasn't shipped

---

### webhook-setup.md

**Created**: Early 2025  
**Archived**: October 27, 2025

**Issue**: Basic webhook setup instructions without two-composite specifics

**Why Archived**:
- Covered more comprehensively in TWO-COMPOSITE-ARCHITECTURE.md
- Missing annotation-driven migration details
- Missing storage/compute separation
- Missing related resources pattern

**See Instead**:
- `docs/TWO-COMPOSITE-ARCHITECTURE.md` - Complete two-composite setup and architecture
- `docs/QUICK-START.md` - Quick start guide
- `metacontroller/examples/README.md` - Example-driven setup

---

**Status**: Historical reference only, not current implementation  
**Archived**: October 2025
