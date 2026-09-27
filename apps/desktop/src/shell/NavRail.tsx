import { Identity } from "./Identity";
import { SECTIONS, navigate, useSection } from "./navigation";

export function NavRail() {
  const active = useSection();
  return (
    <nav className="rail" aria-label="MORROW">
      <Identity />
      <ul className="rail__list">
        {SECTIONS.map((section, i) => (
          <li key={section}>
            <button
              type="button"
              className="rail__item"
              aria-current={section === active ? "page" : undefined}
              onClick={() => navigate(section)}
            >
              <span className="rail__index">{String(i + 1).padStart(2, "0")}</span>
              <span className="rail__name">{section}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
