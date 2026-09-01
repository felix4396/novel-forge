# Product

## Register

product

## Users

Solo creators and technically capable builders using a local web workbench to plan, continue, imitate, and batch-generate long-form Chinese web fiction and broader novels. They need model configuration, generation control, corpus import, style learning, review gates, and traceable state rather than a simple chat prompt surface.

## Product Purpose

AI Novel Production Engine exists to make long-form AI novel generation stable, controllable, and observable. Success means a user can start from an idea or imported sample chapters, configure external model providers, route tasks by capability, generate chapters in batches, pause at risk points for human confirmation, and preserve continuity through StoryState, Reference Corpus, Skills, StyleProfile, ReviewGate, and StatePatch.

## Brand Personality

Pragmatic, controlled, production-minded. The interface should feel like an operator console for creative production: clear status, low ambiguity, and enough density for repeated work without hiding important risk.

## Anti-references

Avoid marketing-style landing surfaces inside the app, decorative card clutter, ambiguous provider labels such as "available" when only a key is present, and model controls that mix text generation, embedding, image generation, and local-service health into one unclear state.

## Design Principles

- Make state explicit: configured, enabled, connected, failed, and unconfigured must mean different things.
- Keep model routing as the source of truth for generation behavior while provider cards manage credentials and coarse enablement.
- Separate capability classes: text generation, embedding, image generation, and local services need distinct health checks.
- Optimize for controlled batch production with human approval at risky state changes.
- Preserve continuity and auditability through visible evidence, retrieved context, review results, and state patches.

## Accessibility & Inclusion

Use product UI defaults with clear focus states, readable contrast, concise Chinese copy, stable loading states, and reduced-motion-safe transitions. Status should not rely on color alone; labels must carry the meaning.
