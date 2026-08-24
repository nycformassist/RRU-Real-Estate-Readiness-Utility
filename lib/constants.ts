export const PHASE_RULES: Record<number, { field: string; description: string; rule: string }> = {
  1: {
    field: "fullName",
    description: "Buyer's Full Name",
    rule: "Must contain at least a first and last name.",
  },
  2: {
    field: "contactInfo",
    description: "Contact Information",
    rule: "Must contain a valid-looking email address OR a phone number (at least 7 digits).",
  },
  3: {
    field: "buyingGoal",
    description: "Primary Buying Goal",
    rule: "Must indicate their intent (e.g., primary residence, investment, second home, exploring).",
  },
  4: {
    field: "location",
    description: "Target Location",
    rule: "Must mention cities, neighborhoods, boroughs, or zip codes they are interested in.",
  },
  5: {
    field: "budget",
    description: "Target Budget",
    rule: "Must contain a monetary value, price range, or a clear statement that they do not know.",
  },
  6: {
    field: "mortgageStatus",
    description: "Financing Status",
    rule: "Must indicate if they are paying cash, pre-approved, or need to speak with a lender.",
  },
  7: {
    field: "downPayment",
    description: "Down Payment Amount",
    rule: "Must indicate an amount (percentage or dollar figure) or state they are unsure.",
  },
  8: {
    field: "timeline",
    description: "Purchase Timeline",
    rule: "Must indicate a time frame for closing or moving (e.g., ASAP, 3 months, next year).",
  },
  9: {
    field: "mustHaves",
    description: "Property Must-Haves",
    rule: "Must list at least one required feature (e.g., number of beds/baths, yard, parking).",
  },
  10: {
    field: "obstacles",
    description: "Obstacles & Concerns",
    rule: "Must identify any hurdles (credit, selling current home) or state there are none.",
  },
};