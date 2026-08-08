import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ReliveScreen from "../../components/ReliveScreen";
import { makeSession } from "../helpers/fixtures";

describe("ReliveScreen", () => {
  it("renders the empty state when there are no sessions", () => {
    render(<ReliveScreen sessions={[]} headingId="main-heading-relive" />);
    expect(screen.getByRole("heading", { name: "Relive" })).toBeInTheDocument();
    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
  });

  it("lists a completed session when one exists", () => {
    const session = makeSession({
      summary: { total: 3, answered: 2, skipped: 1, totalMs: 120_000, avgContent: 4, avgDelivery: 3 },
    });
    render(<ReliveScreen sessions={[session]} />);
    expect(screen.getByText("Senior Engineer · Acme")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // answered
    expect(screen.getByText("1")).toBeInTheDocument(); // skipped
  });
});
