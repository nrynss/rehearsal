import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Expander } from "../../components/Expander";

/**
 * The collapse is height-based via CSS classes (rows-closed / rows-open), which
 * jsdom never applies. So we assert the ARIA contract (aria-expanded, the
 * aria-controls wiring) and the presence/absence of the open class instead of
 * computed visibility.
 */
describe("Expander", () => {
  it("renders the title, meta, and a collapsed disclosure button", () => {
    render(
      <Expander entry="01" title="My job" meta="Acme · linkedin.com" idPrefix="x">
        <p>Hidden content</p>
      </Expander>,
    );
    expect(screen.getByText("My job")).toBeInTheDocument();
    expect(screen.getByText("Acme · linkedin.com")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /My job/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-controls", "x-body");
    // Collapsed by default: the content body carries the closed class.
    const body = document.getElementById("x-body");
    expect(body).toHaveClass("rows-closed");
    expect(body).not.toHaveClass("rows-open");
  });

  it("toggles aria-expanded and the collapse class when the trigger is clicked", () => {
    render(
      <Expander entry="01" title="My job" idPrefix="x">
        <p>Hidden content</p>
      </Expander>,
    );
    const button = screen.getByRole("button", { name: /My job/ });
    const body = document.getElementById("x-body");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(body).toHaveClass("rows-open");
    expect(body).not.toHaveClass("rows-closed");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(body).toHaveClass("rows-closed");
  });

  it("renders open when defaultOpen is true", () => {
    render(
      <Expander entry="01" title="My job" defaultOpen idPrefix="x">
        <p>Visible content</p>
      </Expander>,
    );
    expect(screen.getByRole("button", { name: /My job/ })).toHaveAttribute("aria-expanded", "true");
  });
});
