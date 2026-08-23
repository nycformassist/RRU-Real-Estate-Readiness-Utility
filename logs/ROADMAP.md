# Fortress Intake AI - Roadmap Log

## Current Status (v3.1)
**Objective**: Build a deterministic, highly-controlled 10-phase AI Legal Intake assistant capable of structured data extraction.

### Completed Milestones
- [x] Basic chat interface setup.
- [x] Integration with `@google/genai` (Flash 3.1).
- [x] Implementation of the 10-Phase Roadmap structure.
- [x] UI synchronization based on `[PHASE: X]` prefixes.
- [x] Strict conversational pacing ("Ping-Pong Rule").
- [x] Phase 1 Information Gatekeeping (Name, Phone, Email, Opposing Party).
- [x] Automated legal categorization (Internal inference).
- [x] On-demand data structuring (JSON generation upon explicit "Finish Interview" command).

### Upcoming Milestones
- [ ] **Airtable Integration**: Fully wire the `/api/intake` endpoint to push the generated `<STRUCTURED_DATA>` to a live Airtable Base.
- [ ] **Document Collection**: Add drag-and-drop file upload capabilities to attach files/images to the intake process.
- [ ] **Authentication/Security**: Add access control to the intake portal.
- [ ] **Summary Exports**: Enable PDF generation of the `<ATTORNEY_REPORT>` for the client and staff.
- [ ] **Resilience**: Implement local storage caching so chat sessions survive accidental page reloads.

## The 10-Phase Flow
1. **Control & Contact**: Name, Phone, Email, Opposing Party
2. **Case Identification**: Category, Date, Location
3. **Liability**: Facts, fault, initial evidence
4. **Damages**: Medical, Financial, Emotional
5. **Timeline & Urgency**: Deadlines, prior representation
6. **Recoverability**: Defendant assets, communications
7. **Client Quality**: Goals, expectations
8. **Internal Scoring**: Deterministic 0-12 score mapping
9. **Attorney Report**: Narrative generation (Triggered manually)
10. **Structured JSON**: Airtable-ready extraction (Triggered manually)
