# Trader onboarding and funding

Super Admin-created accounts require a valid mobile number. Broker-created trader accounts remain pending until the Super Admin decides the request.

## Receiving accounts

In **Fees → Bank accounts & UPI**, the Super Admin can add:

- A bank account: display name, account holder, bank name, account number, IFSC and branch; an optional UPI ID can be attached to the same account.
- A UPI destination: display name, account holder and UPI ID.

The forms validate names, account numbers, IFSC and UPI IDs. Bank and branch names cannot contain digits; branch names are limited to 60 characters. A QR code is generated locally from the entered UPI ID and account holder name. No third-party QR generation service receives payment details.

Only active receiving accounts appear to brokers and traders. Existing payment details remain immutable: disable an old destination and add its replacement.

## Broker creates a trader

1. Enter the account details and opening amount.
2. Choose the Super Admin receiving account. Bank details, UPI ID and QR are shown here.
3. Enter the payer name, UTR/reference and payment date. A screenshot can be attached.

The opening amount also records the amount paid. The account and its evidence are saved in one transaction. Invalid destinations, malformed proof and duplicate payment references roll back account creation.

The Super Admin's account-approval dialog shows the submitted payment details and screenshot. The Super Admin must check the bank statement before approval; a submitted reference or screenshot is not automatic proof that funds arrived.

Approval activates the trader and credits the opening balance atomically, once. Rejection requires a reason, leaves the account unable to sign in, credits no balance, and notifies the requesting broker. Rejected requests remain visible with their reason and cannot be reactivated through the normal account-status action.

Legacy pending requests without attached evidence show a warning so the Super Admin can verify them manually.

## Trader adds funds

**Withdraw**, **Add script** and **Add funds** share one row on the watchlist in web and mobile.

For Add funds, the trader enters the amount, chooses an active receiving account, records the payment reference and payer details, then reviews the request. The Super Admin sees the evidence in transaction details and the approval dialog. The trading balance changes only after approval.

Broker-submitted deposits also require evidence. Super Admin adjustments can be made without uploading a payment record. Withdrawals keep their existing flow.

UTRs are normalized to uppercase and cannot fund multiple opening/deposit requests. Request retries with the same idempotency key return the original request; a changed reference or destination requires a new key. UTRs, payer names and screenshots are encrypted at rest. Evidence is visible only to the account owner, assigned broker and Super Admin, subject to existing reset visibility rules. Super Admin screenshot views are audited.

## Deployment

Deploy API migrations `0028_trader_rejection` and `0029_payment_evidence` with the API before deploying clients that query the new fields. Render's API start script runs migrations automatically. Local API startup also runs migrations through `predev`.

No new environment variables or mobile native dependencies are required. Rebuild the APK to include the mobile forms.
