#!/bin/sh
# Creates a self-signed code-signing identity in the login keychain, so builds signed
# with it keep one designated requirement and macOS keeps Accessibility and Screen
# Recording grants across updates (S29.2). It does not replace notarization.
# Usage: scripts/package/create-signing-identity.sh ["Common Name"]
set -eu

NAME="${1:-Gentle Dot Local Signing}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
	echo "A certificate named \"$NAME\" already exists; nothing to do."
	security find-identity -p codesigning | grep "$NAME" || true
	exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

cat >"$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
	-keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/cert.cnf" 2>/dev/null
# A random one-time password: the .p12 only lives inside $WORK until it is imported.
PASS="$(openssl rand -hex 16)"
openssl pkcs12 -export -legacy -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
	-name "$NAME" -out "$WORK/identity.p12" -passout "pass:$PASS" 2>/dev/null ||
	openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
		-name "$NAME" -out "$WORK/identity.p12" -passout "pass:$PASS"

security import "$WORK/identity.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign
# No trust setting is needed: codesign signs with an untrusted identity, and the
# designated requirement pins the certificate's leaf hash, which is what TCC checks.

echo "Created \"$NAME\":"
security find-identity -p codesigning | grep "$NAME"
