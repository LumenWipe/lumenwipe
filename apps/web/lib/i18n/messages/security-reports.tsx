import type { Locale } from "@/lib/i18n/locale";
import type { FixStatus, Severity } from "@/lib/security-reports";

const en = {
  metadata: {
    title: "Security reports",
    description:
      "The security reports published for LumenWipe, each with its scope, date, who performed it, the code it reviewed, its findings by severity and their fix status.",
  },
  eyebrow: "Security",
  heading: "Security reports",
  lede: "Each security report published for LumenWipe is listed here: its scope, its date, who performed it, the version of the code it reviewed, its findings by severity with the fix status of each, and the full report.",
  empty: {
    heading: "No security report has been published yet",
    body: "What exists today was written by the LumenWipe maintainers. It is self-assessed: nobody outside the project has checked it.",
    selfAssessed: "Self-assessed",
    documents: {
      threatModel: {
        title: "STRIDE threat model",
        body: "Each surface's threats, the mitigation for each, and the tests behind them.",
      },
      remediationPlan: {
        title: "Security tooling remediation plan",
        body: "What the dependency scan, static analysis and secret scan found, and the resolution of each finding.",
      },
    },
  },
  report: {
    scope: "Scope",
    date: "Date",
    performedBy: "Performed by",
    commit: "Code reviewed",
    summary: "Findings by severity",
    findings: "Findings and fix status",
    noFindings: "No findings.",
    fullReport: "Read the full report",
  },
  severity: {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
    informational: "Informational",
  } satisfies Record<Severity, string>,
  status: {
    fixed: "Fixed",
    mitigated: "Mitigated",
    accepted: "Accepted risk",
    open: "Open",
  } satisfies Record<FixStatus, string>,
  backToSecurity: "Back to security",
};

export type SecurityReportsCopy = typeof en;

const es: SecurityReportsCopy = {
  metadata: {
    title: "Reportes de seguridad",
    description:
      "Los reportes de seguridad publicados para LumenWipe, cada uno con su alcance, fecha, quién lo hizo, el código que revisó, sus hallazgos por severidad y el estado de corrección de cada uno.",
  },
  eyebrow: "Seguridad",
  heading: "Reportes de seguridad",
  lede: "Aquí se lista cada reporte de seguridad publicado para LumenWipe: su alcance, su fecha, quién lo hizo, la versión del código que revisó, sus hallazgos por severidad con el estado de corrección de cada uno, y el reporte completo.",
  empty: {
    heading: "Todavía no se ha publicado ningún reporte de seguridad",
    body: "Lo que existe hoy lo escribieron los mantenedores de LumenWipe. Es una autoevaluación: nadie fuera del proyecto lo ha revisado.",
    selfAssessed: "Autoevaluación",
    documents: {
      threatModel: {
        title: "Modelo de amenazas STRIDE",
        body: "Las amenazas de cada superficie, la mitigación de cada una y las pruebas que la respaldan.",
      },
      remediationPlan: {
        title: "Plan de remediación de las herramientas de seguridad",
        body: "Lo que encontraron el análisis de dependencias, el análisis estático y la búsqueda de secretos, y la resolución de cada hallazgo.",
      },
    },
  },
  report: {
    scope: "Alcance",
    date: "Fecha",
    performedBy: "Realizado por",
    commit: "Código revisado",
    summary: "Hallazgos por severidad",
    findings: "Hallazgos y estado de corrección",
    noFindings: "Sin hallazgos.",
    fullReport: "Leer el reporte completo",
  },
  severity: {
    critical: "Crítica",
    high: "Alta",
    medium: "Media",
    low: "Baja",
    informational: "Informativa",
  },
  status: {
    fixed: "Corregido",
    mitigated: "Mitigado",
    accepted: "Riesgo aceptado",
    open: "Abierto",
  },
  backToSecurity: "Volver a seguridad",
};

export const SECURITY_REPORTS: Record<Locale, SecurityReportsCopy> = { en, es };
