import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const billingMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  checkout: vi.fn(),
  portal: vi.fn(),
}));

vi.mock("./billing-api", () => ({
  getBillingStatus: billingMocks.getStatus,
  createCheckout: billingMocks.checkout,
  createPortal: billingMocks.portal,
}));

import { BillingAccount } from "./BillingAccount";

beforeEach(() => {
  billingMocks.getStatus.mockResolvedValue({ configured: true, creditsConfigured: true, subscription: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Billing account", () => {
  it("shows configured monthly and annual upgrade paths for a free account", async () => {
    render(<BillingAccount />);
    expect(await screen.findByText("Free")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose monthly" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Choose annual" })).toBeEnabled();
  });

  it("shows the subscription state and Customer Portal action", async () => {
    billingMocks.getStatus.mockResolvedValue({
      configured: true,
      creditsConfigured: true,
      subscription: {
        id: "sub_test",
        status: "active",
        entitled: true,
        interval: "annual",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: "2027-08-30T00:00:00.000Z",
      },
    });
    render(<BillingAccount />);
    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Annual plan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeEnabled();
  });

  it("fails safely when billing status cannot be read", async () => {
    billingMocks.getStatus.mockRejectedValue(new Error("unavailable"));
    render(<BillingAccount />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Billing is temporarily unavailable");
    expect(screen.queryByRole("button", { name: "Choose monthly" })).not.toBeInTheDocument();
  });
});
