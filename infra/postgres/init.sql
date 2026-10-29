CREATE ROLE auth_svc LOGIN PASSWORD 'dev-only-password';
CREATE DATABASE auth OWNER auth_svc;
REVOKE ALL ON DATABASE auth FROM PUBLIC;

CREATE ROLE catalog_svc LOGIN PASSWORD 'dev-only-password';
CREATE DATABASE catalog OWNER catalog_svc;
REVOKE ALL ON DATABASE catalog FROM PUBLIC;

CREATE ROLE booking_svc LOGIN PASSWORD 'dev-only-password';
CREATE DATABASE booking OWNER booking_svc;
REVOKE ALL ON DATABASE booking FROM PUBLIC;

CREATE ROLE payment_svc LOGIN PASSWORD 'dev-only-password';
CREATE DATABASE payment OWNER payment_svc;
REVOKE ALL ON DATABASE payment FROM PUBLIC;

CREATE ROLE notification_svc LOGIN PASSWORD 'dev-only-password';
CREATE DATABASE notification OWNER notification_svc;
REVOKE ALL ON DATABASE notification FROM PUBLIC;
