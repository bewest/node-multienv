# Nightscout Multi-Tenant Platform Documentation

## Quick Navigation

### 🚀 Getting Started
- **[Quick Start Guide](QUICK-START.md)** - Get up and running quickly
- **[Two-Composite Architecture](TWO-COMPOSITE-ARCHITECTURE.md)** - Gen 4 architecture overview (START HERE for Gen 4)

### 🏗️ Architecture
- **[Architecture Evolution](ARCHITECTURE-EVOLUTION.md)** - Complete history of 5 generations + ADR-style design decisions
- **[Component Relationships](COMPONENT-RELATIONSHIPS.md)** - Gen 3b architecture details (production: 1300 sites)
- **[Cloud-Native Startup](CLOUD-NATIVE-STARTUP.md)** - Multi-mode container architecture

### 📚 Reference Documentation
- **[Container Parameters](CONTAINER-PARAMETERS.md)** - Comprehensive configuration reference
- **[Labels and Annotations](LABELS-AND-ANNOTATIONS.md)** - Label/annotation analysis + recommendations
- **[Labels in Use Today](LABELS-IN-USE-TODAY.md)** - Current label usage in production code
- **[Validation Checklist](VALIDATION-CHECKLIST.md)** - Testing and validation guide
- **[Testing Guide](testing-guide.md)** - Test procedures

### 🔧 Integration & Setup
- **[Metacontroller Integration](METACONTROLLER-INTEGRATION.md)** - Webhook protocol reference
- **[Webhook Architecture](WEBHOOK-ARCHITECTURE.md)** - Webhook implementation patterns
- **[Migration Guide](MIGRATION-FROM-LEGACY.md)** - Gen 3b → Gen 4 migration (two-composite)

### 📋 API Specifications (OpenAPI)
- **[Gen 4 API](openapi-gen4-metacontroller.yaml)** - Two-composite architecture (Metacontroller webhooks)
- **[Gen 3 API](openapi-gen3-deployment.yaml)** - Deployment controller (REST API)
- **[Gen 2 API](openapi-gen2-inspector.yaml)** - Inspector API
- **[Gen 1 API](openapi-gen1-multienv.yaml)** - Multienv API

---

## Documentation Structure

### Current State (October 2025)
- **Production**: Gen 3b (deployment-controller) - 1300 sites
- **In Development**: Gen 4 (two-composite Metacontroller) - not yet shipped

### Gen 4 Two-Composite Architecture

Gen 4 separates storage concerns from compute concerns using two independent composites:

```
Storage Composite          Compute Composite
Secret → MongoDB          ConfigMap → Nightscout
      → Migration                  → CDC
```

**Key Documents:**
1. [TWO-COMPOSITE-ARCHITECTURE.md](TWO-COMPOSITE-ARCHITECTURE.md) - Main architecture doc
2. [ARCHITECTURE-EVOLUTION.md](ARCHITECTURE-EVOLUTION.md) - Design decisions (why two-composite?)
3. [openapi-gen4-metacontroller.yaml](openapi-gen4-metacontroller.yaml) - API specification

**Examples:**
- [metacontroller/examples/](../metacontroller/examples/) - Working examples with comprehensive README

### Archived Documentation

Documents that have been superseded or consolidated:

- **[archive/docs/](../archive/docs/)** - Outdated implementation docs (monolithic composite approach)
- **[archive/monolithic-composite/](../archive/monolithic-composite/)** - Alternative approach (not shipped)
- **[archive/migration-docs/](../archive/migration-docs/)** - Old migration docs (superseded)
- **[archive/examples/](../archive/examples/)** - CRD-style examples (not shipped)

---

## Documentation Condensation (October 2025)

### Archived
- ✅ `IMPLEMENTATION-SUMMARY.md` → Described monolithic approach (never shipped)
- ✅ `webhook-setup.md` → Basic setup (covered in TWO-COMPOSITE-ARCHITECTURE.md)
- ✅ `DATABASE-MIGRATION-STRATEGY.md` → Superseded by TWO-COMPOSITE-ARCHITECTURE.md
- ✅ `DATABASE-MIGRATION-AUTOMATED.md` → Superseded by TWO-COMPOSITE-ARCHITECTURE.md

### Enhanced
- ✅ Added scope notes to COMPONENT-RELATIONSHIPS.md (Gen 3 specific)
- ✅ Updated MIGRATION-FROM-LEGACY.md (Gen 3b → Gen 4 two-composite)
- ✅ Updated METACONTROLLER-INTEGRATION.md (two-composite reference)
- ✅ Enhanced ARCHITECTURE-EVOLUTION.md (ADR-style design decisions)

### Reorganized
- ✅ Consolidated examples in `metacontroller/examples/` with comprehensive README
- ✅ Archived monolithic composite in `archive/monolithic-composite/` with detailed README
- ✅ Created clear archive structure with explanatory READMEs

---

## Key Design Decisions

See [ARCHITECTURE-EVOLUTION.md - Design Decisions](ARCHITECTURE-EVOLUTION.md#design-decisions--alternatives-considered) for comprehensive ADR-style documentation covering:

1. **Two-Composite vs Monolithic Architecture** - Why separate storage/compute?
2. **Annotation-Driven Migration** - Why use annotations instead of ConfigMap fields?
3. **Related Resources vs Ownership** - Blast radius protection pattern
4. **Secret vs ConfigMap for Credentials** - Security isolation
5. **Storage-Type Annotation Control** - Supporting shared/dedicated MongoDB

---

## Contributing to Documentation

When adding new documentation:

1. **Check for redundancy** - Don't duplicate existing content
2. **Update this index** - Add your doc to the appropriate section
3. **Cross-reference** - Link to related docs
4. **Add scope notes** - Clarify which generation/architecture the doc describes
5. **Archive old docs** - Move superseded docs to `archive/` with README explaining why

---

## Questions?

- **Gen 4 Architecture**: Start with [TWO-COMPOSITE-ARCHITECTURE.md](TWO-COMPOSITE-ARCHITECTURE.md)
- **Why Gen 4?**: See [ARCHITECTURE-EVOLUTION.md](ARCHITECTURE-EVOLUTION.md)
- **How to migrate?**: See [MIGRATION-FROM-LEGACY.md](MIGRATION-FROM-LEGACY.md)
- **Examples**: See [metacontroller/examples/](../metacontroller/examples/)
