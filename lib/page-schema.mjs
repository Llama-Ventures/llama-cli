export const LIVE_DEAL_PAGE_SCHEMA_PATH = "/api/agent/page-schema";
export const MAX_PAGE_SCHEMA_FIELDS = 20;

export function buildPageSchemaPath({ fields = [], section } = {}) {
  const normalizedFields = [...new Set(
    fields.map((field) => String(field).trim()).filter(Boolean),
  )];
  const normalizedSection = section === undefined ? "" : String(section).trim();

  if (normalizedFields.length && normalizedSection) {
    throw new Error("Choose exact fields or one section, not both.");
  }
  if (normalizedFields.length > MAX_PAGE_SCHEMA_FIELDS) {
    throw new Error(`Choose at most ${MAX_PAGE_SCHEMA_FIELDS} exact fields per request.`);
  }
  if (section !== undefined && !normalizedSection) {
    throw new Error("Page schema section cannot be empty.");
  }

  const params = new URLSearchParams();
  for (const field of normalizedFields) params.append("field", field);
  if (normalizedSection) params.set("section", normalizedSection);
  return `${LIVE_DEAL_PAGE_SCHEMA_PATH}${params.size ? `?${params}` : ""}`;
}
