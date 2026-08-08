import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Tabs } from "../../components/Tabs";
import type { TabDef } from "../../components/Tabs";

const tabs: TabDef[] = [
  { id: "research", label: "Research", panel: <p>Research panel</p> },
  { id: "rehearse", label: "Rehearse", panel: <p>Rehearse panel</p> },
  { id: "relive", label: "Relive", panel: <p>Relive panel</p> },
];

function renderTabs(active: TabDef["id"] = "research", onChange = vi.fn()) {
  return render(<Tabs tabs={tabs} active={active} onChange={onChange} idPrefix="test" labelledBy="Test tabs" />);
}

describe("Tabs", () => {
  it("renders a tablist with role=tab buttons and aria-selected on the active one", () => {
    renderTabs("research");
    expect(screen.getByRole("tablist", { name: "Test tabs" })).toBeInTheDocument();
    const research = screen.getByRole("tab", { name: "Research" });
    expect(research).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Rehearse" })).toHaveAttribute("aria-selected", "false");
  });

  it("shows only the active tabpanel", () => {
    renderTabs("research");
    expect(screen.getByRole("tabpanel", { name: "Research" })).toBeVisible();
    // Inactive panels are hidden via the `hidden` attribute, which removes
    // them from the accessibility tree — so queryByRole cannot find them.
    expect(screen.queryByRole("tabpanel", { name: "Rehearse" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tabpanel", { name: "Relive" })).not.toBeInTheDocument();
  });

  it("selects a tab on click and reports it via onChange", () => {
    const onChange = vi.fn();
    renderTabs("research", onChange);
    fireEvent.click(screen.getByRole("tab", { name: "Rehearse" }));
    expect(onChange).toHaveBeenCalledWith("rehearse");
  });

  it("uses roving tabindex — only the active tab is in the tab order", () => {
    renderTabs("research");
    expect(screen.getByRole("tab", { name: "Research" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Rehearse" })).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus + selection with the Arrow keys", () => {
    const onChange = vi.fn();
    renderTabs("research", onChange);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Research" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("rehearse");
  });

  it("Home jumps to the first tab and End to the last", () => {
    const onChange = vi.fn();
    renderTabs("relive", onChange);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Relive" }), { key: "Home" });
    expect(onChange).toHaveBeenCalledWith("research");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Relive" }), { key: "End" });
    expect(onChange).toHaveBeenCalledWith("relive");
  });
});
