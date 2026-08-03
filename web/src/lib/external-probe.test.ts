import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from 'node:tls'
import { Socket, type Server } from 'node:net'
import { probeExternally, httpsExternalRequest, type ExternalDeps, type ExternalScheme } from './external-probe.js'

// `_getActiveHandles` is a real, long-standing Node internal (not in
// @types/node), used here for exactly what it's for: detecting a socket
// handle leak in a test. Same technique `agent/src/probe.test.ts` uses for
// the on-box transport's own socket-drain test. Narrowly typed rather than
// cast through `any`.
type ProcessWithActiveHandles = typeof process & { _getActiveHandles?: () => unknown[] }

function countActiveSockets(): number {
  const handles = (process as ProcessWithActiveHandles)._getActiveHandles?.() ?? []
  return handles.filter((h) => h instanceof Socket).length
}

const at = (d: string) => new Date(d)

/**
 * Three test-only self-signed certificate/key pairs, generated once for
 * this file and pinned as literal PEM. None names a real host: `CERT_A`
 * and `CERT_B` both carry `CN=127.0.0.1` with an IP SAN for the loopback
 * address every test server binds to, and `CERT_MISMATCH` deliberately
 * carries the invented `not-this-host.example.invalid` name instead --
 * this repository is public, so no fixture here may name a real system.
 *
 * `CERT_A` and `CERT_B` expire on two DIFFERENT, deliberately distant
 * dates (2035-06-15 and 2036-11-03). That difference is load-bearing: a
 * test that only ever exercises one certificate cannot tell a real
 * handshake read from a hardcoded return value apart, since both would
 * report the same date. Serving each from its own listener and asserting
 * two DIFFERENT expiries out of the same code path is what discriminates.
 */
const CERT_A = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUFXU3VUb6z7jBQ+VXL3mkSsoFZHUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI0MDEwMTAwMDAwMFoXDTM1MDYx
NTAwMDAwMFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAuE1R4uSob5UmiRi5Yx9ghC4jiXZmh5W2F0Jkk95QBx47
JypAWTs/rP3R71SmWWQKDRoJ+VCHxROncGTlwoKCSzHOpWSpG0KC2dHcYeZHTcSn
e/yFneYzfrIiw5UNM/u+PdGQkPXcoqDlT0Jj8v1LWeq5YELfLqNtCmDiDvMthc61
TF1jPCYyqayvU4DAQN6JNc3CFe/0YKto3N/94cmW0CW2OA2T7hapPYfhyh8frCfM
ILUxckZPY33QjhBlx/5lT9lMWv5dr+6n8nLn+zCrWx6zXz2qRnIhG8GwMvNKOFd1
KtbawCUsjNXJCdo63I33s/qQzdMq0IGfuPYZhohK3QIDAQABo2QwYjAdBgNVHQ4E
FgQUURZBUbf6HGsuOM7J+xn1J24eHmowHwYDVR0jBBgwFoAUURZBUbf6HGsuOM7J
+xn1J24eHmowDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG
SIb3DQEBCwUAA4IBAQBGPx98eE+yAuk+4yABS1d+3desUBx4XJSeb/rcd+50KMD2
yXQq1CaeGVZV9HtbecHyvq6c/AcVSpXe83rWT6LNOZTZQHb0OUYg1aJDhyW84TjN
gy/v2ib14oUnOfMiQVS5v9oOjPEXdlbFP30MkZAuXpskCoUZQsj3TFVyL4iRLXEX
8gjckdvvpNfvgWZz0HWF5fghLLmrdWSjsS9iNLtpfcweMzPFB379Hk8udV+1cWK8
E40KnYj9Ehg1eVYT/PwCrEyHZrv0mkZMWM5pV8ebeTmoMWDc0Y7/KdqVyk8tB4aN
l+VPPyaD2Qppzd+Mjb6zPl7ciGEBOtI7MR+JdTpK
-----END CERTIFICATE-----`

const KEY_A = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC4TVHi5KhvlSaJ
GLljH2CELiOJdmaHlbYXQmST3lAHHjsnKkBZOz+s/dHvVKZZZAoNGgn5UIfFE6dw
ZOXCgoJLMc6lZKkbQoLZ0dxh5kdNxKd7/IWd5jN+siLDlQ0z+7490ZCQ9dyioOVP
QmPy/UtZ6rlgQt8uo20KYOIO8y2FzrVMXWM8JjKprK9TgMBA3ok1zcIV7/Rgq2jc
3/3hyZbQJbY4DZPuFqk9h+HKHx+sJ8wgtTFyRk9jfdCOEGXH/mVP2Uxa/l2v7qfy
cuf7MKtbHrNfPapGciEbwbAy80o4V3Uq1trAJSyM1ckJ2jrcjfez+pDN0yrQgZ+4
9hmGiErdAgMBAAECggEAAdqkeYv2vJ/U/xyuQynqvozfE0ALYJwBp9k/Cfr63IXe
1Xi7Pf3Df1OF9aQcQ+dZ1iKBbPsoHbQiNpZYdpNgIsgel1/19yeKCaciHvACODn2
vCx6eAl7uIlFO6kRTjxFmfln1jV+Lm3ZvYLiK4ZSm2+p+FoKRPDxWC3iVRrE+StQ
3HcEgRdWtFsCrzU8ZW75+0Mm/2WFH1rFPOmjcFcEGVFyk13YkGk4TQDBFQm/tQLR
y0eJow6F3NQNHGYi+ZxCc9lFgHatSPop9qRY29U+1CkXzosHc87kfc5YTd19RdTU
lJYnXy53xY6FAs8Ste5mZ0EI/AEq52JKdCg+g5D7xwKBgQD9/tNRUnvXD0rJWUmx
RrfGy2qQkm8Qx9HPODXdEh7JOFh+fIJ3HRl+QDO9SQuaNlNXx1r+nzoxAf63x98q
rUIaXUdstTR6UpOzVBvDuoM62uSTd/9ejKzQyeDo8J8SsF5hjdoiL27epTM21gVo
9yR8ykvPfqlcpkiewnTlYE3x4wKBgQC5wa9vfMWoBVnEf+VIas4bW56KLiZ804/x
wL9FH/HEfmOuxul0jESH+e3fZDbWlvrG3Hc8frno+JMx6nqgvZwoHVmhKHTpSNWj
vDwT1e9O80TkmOlDDWQf8HsK0VbDz//n7IjfB/rHMoA4TVkkSitXF2iJiQmI/YhR
IFMMEtpsPwKBgQCIvDNk1yPGDfxz0raCUhDDW2S9+acDAJ9pj9gncAbUypmRVlQh
7a94sPVplDZDybUqTy8kXfHEyk8m/tmcLvOkH81Ar3hV1bif1MqxnunguFBPN01p
yA+MwvFqVYc9V2cn22av+psUDxk4DxWQgWPKLlmLlaN1NitoFEU76pFrgwKBgDHS
m2WBx9obJUqpKyxTSVjZKBrT6grNC+zB0AuQV95mMAJu46sY/ECkboLedD72W+j+
tRSKwP6VvZVD2QRIFxxDUwkAuurfWD4EfPCtDvTUFwRhZx9O9i4C6F2sbGM05OSl
8sgvcbn/95giVuh+5EUFyEorcV1G80sfKmcwn1ktAoGAI3X5E7+CrVDWE0/YmJiy
S9yiWIv9M94lrPa/t7cS5ljJqCJdUb7tFkmHSeXQEyJsD+QPjnNYzv7iDv2vUw+Z
kACUetV6P1HqwQtC1E7I0EJc5WXF8isOd4vW1MeLwJ3eYinUviCJYZH3aEKxeabR
NMDeYYUKBurpARE8ox4zwso=
-----END PRIVATE KEY-----`

const CERT_A_EXPIRY = at('2035-06-15T00:00:00.000Z')

const CERT_B = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUQKyEL2vmC8KOzorfcSU6tw1u8qcwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI0MDEwMTAwMDAwMFoXDTM2MTEw
MzAwMDAwMFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAtps1VDIXv2GDX3CVLq11tZdJ7R8XhWggutWzF0MlLtVZ
ouJ8JRDjGQT7CnCT2PrhC6nMtyKDlqzYEXjv79C4ZiOib2o4rNxGNskHu/1mQP1V
064/kfQwXwTK+JP5T1OIthjPzOxPjO8OGeF/k58Oa+eBHb7YjZjNKrhqckGnUIsg
zcohw1LNfFY7Od6/0rIlEVXAanKqJOteCFMWGjdg3NJSdlzE3EiAXV+isZlefkwO
wORPU+dzK5zRV4vX0PfAINGmL7Psr3cFKcDCalQY6i/m1eek9OL4LEV8cZ+QUyd1
qydxu3+uZshPqRiB2AWnLe431Kshyu5HT2Z0GyukKQIDAQABo2QwYjAdBgNVHQ4E
FgQUokTROhswY8easaTpIbnS5nmhbLgwHwYDVR0jBBgwFoAUokTROhswY8easaTp
IbnS5nmhbLgwDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG
SIb3DQEBCwUAA4IBAQChzi+zA1bvqF/LuqZZ4xWwL0NTVXSXq+6vnM2g8jIM0a2J
dSZE1AuVzGFoBz6ptWayAVmcsAlXNIIrBe6u93HtBMUBmYYXXnlCZR8Vf/auqHy3
JZUUAZymOn5M5pStKQmAZGUxJuYFW+hna7CSLiuJn4tUka/VRK07YXzOQ/H6AVQf
uknOShkKK2ObIDbUYJBuK3s2hQlYUgrEDCdtbdTN6+3jG/DtfF+dBt/N+ES0wuVw
lquZHBgKhIRb7JN/3qwXP8WnnTzyLQdXOm7YaBSkxsfFbLcW3/Jm7eWcNX+DQwRc
yvZZG3DE8dPSzf4rfKTOKYqlP5Q3PLj9ahZC32IY
-----END CERTIFICATE-----`

const KEY_B = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC2mzVUMhe/YYNf
cJUurXW1l0ntHxeFaCC61bMXQyUu1Vmi4nwlEOMZBPsKcJPY+uELqcy3IoOWrNgR
eO/v0LhmI6Jvajis3EY2yQe7/WZA/VXTrj+R9DBfBMr4k/lPU4i2GM/M7E+M7w4Z
4X+Tnw5r54EdvtiNmM0quGpyQadQiyDNyiHDUs18Vjs53r/SsiURVcBqcqok614I
UxYaN2Dc0lJ2XMTcSIBdX6KxmV5+TA7A5E9T53MrnNFXi9fQ98Ag0aYvs+yvdwUp
wMJqVBjqL+bV56T04vgsRXxxn5BTJ3WrJ3G7f65myE+pGIHYBact7jfUqyHK7kdP
ZnQbK6QpAgMBAAECggEABmsTJ0fxdL0ZMIAVBkR7iCvuocJ/gaVkzRxYxJ8MDgba
tTJvuZ/L06PMrRPC5pP+1/maY+93H5MorwiIqm20JYboHTFnF5BQeXl8Z5ui/fLJ
kvyjaF5kWtqgxbbxwtuFSR07JJFDxIjcfoViBg7Ho3xKGgEMvIFb6L39o9Fx7489
Gz0QNK8X+QlW9wBgCq1XB/HXXnYySp9WmopkwOyXSzEiyr3/TB/rawj3UGhJGbvs
qgAHzPY0UIK5CPGUBfQvaHdvV5WR8ohaGU8OKh8BXqy0V/D+5lGgtHy7QApgFn44
OxVZoy096BW/NzMuDcVjebsq065FEp6AIj741gFqWQKBgQDiiuDwdx5XwsiACp8E
a97LYlGSlWwMHZduflGcqtCyRvIgPWIzXPWbWxWEeE+Gn1CtRBYQzzn8BOT9tF18
nagn/cctrGZ/fGrkyxdSIBI5PJyeww/xOWGqqMiwd2Zkho5jZOTxS0dCkbcIocPX
aMf1LEd4PiVxlzd8RiuT5GKEhQKBgQDOWckxGn6Dmi3ECZeGKX35r873SWCNmcoo
kJ5dVpRj0MkGuge7xVCcjcbwj69dSWQjF+3F7/plWICkm9Vla9sHXcsW4ONYLvUp
k31SJx6lFvqUaESToo1bueUulGjVdjYxFK85FiiheWtf7cf+9VUBnx02TBs/hfIq
sjMIHTJUVQKBgQCcoWjk2XchNotp++32IJ7qABBmSOlrdwo8WxoSOAgTOvotUEOV
P7CQuWknLgfODFi7c1fOR3jPxpKM1yfMATVCcTRFX+1+N4ewqLp3DbWL3VxsaHGd
Vw8v74LSf7tLxbys/BVOv72FSTpDvZSqWsflu7eua0l4QBUc12dJ2Z5EAQKBgF+Y
Vs2JwZyEG7ma2/iKVlMK8G29L57J5U6fmM4S4xHO0qJsIlMJ2Qt93vDpD8u+yUY8
uqmdQDodIxOfIeAndEPYXtKNgqUCtA77xe3+M4M1vwZru4FNqAEbgKHwnRRu/DIG
rBpdOpt73ZOGW8WwsB3dMbJK1cC68/J1tZCHvh41AoGBAMypB5Q8M4I1DYAEsAP/
z1v8LLAcM02epEq8wlkGFhG1/JKZfHiLaknCnW/XqYb7JLmZzB495Xtgwu/N7sQ+
eg97VQvbCgKT3T0p8eSMgNP/UXJwSASL4unYxqhN6bh4Ry8tnH4n+5h3KVl9Abd8
DIxxcQEmJurpShZF8Kdai7QV
-----END PRIVATE KEY-----`

const CERT_B_EXPIRY = at('2036-11-03T00:00:00.000Z')

/**
 * Deliberately for the invented `not-this-host.example.invalid` name, not
 * for `127.0.0.1` -- connecting to it by IP therefore fails hostname
 * verification (`ERR_TLS_CERT_ALTNAME_INVALID`) even though the
 * certificate itself is otherwise well-formed and, via `ca`, trusted. This
 * isolates the altname-mismatch failure mode from the untrusted-issuer one
 * `CERT_A`/`CERT_B` are used for below.
 */
const CERT_MISMATCH = `-----BEGIN CERTIFICATE-----
MIIDWzCCAkOgAwIBAgIUWvidBM+IIT+H8/QAuyvIwwOhMX0wDQYJKoZIhvcNAQEL
BQAwKDEmMCQGA1UEAwwdbm90LXRoaXMtaG9zdC5leGFtcGxlLmludmFsaWQwHhcN
MjQwMTAxMDAwMDAwWhcNMzUwMTAxMDAwMDAwWjAoMSYwJAYDVQQDDB1ub3QtdGhp
cy1ob3N0LmV4YW1wbGUuaW52YWxpZDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBAJX2TmIH/vkyxpvO12OpYmbskFF8YgcSnkMmvUhCKO6in+copTD3objY
el0jcZwKZ26N0d3ZCTgGgEnNXuADEVNGvepgiXy2eA3apv0B/hiKg53D8LSjbOq1
Gp/u+ZG5X6H3NmENjzAXuopb5q7049jBH6GWfecj141LuXDdnWidl0opB3lo3fZ/
vmQ7BpZGf4LnLCRIc0q3eLcTuodZqkdVLwc1hxhjze3ESvaBFANAqy0o7Bu3U2Rj
WnXh3XIoD0GbIMOGkXt4qjGGregV9Jogghw0u/yuKwvIISxwXgvi7DH2QTCpTj9H
RiTE1lTOe/kvd20BQhYfSDNglMVTXg8CAwEAAaN9MHswHQYDVR0OBBYEFDiQq5ws
mqD8GgZfqNKVVlotIWRqMB8GA1UdIwQYMBaAFDiQq5wsmqD8GgZfqNKVVlotIWRq
MA8GA1UdEwEB/wQFMAMBAf8wKAYDVR0RBCEwH4Idbm90LXRoaXMtaG9zdC5leGFt
cGxlLmludmFsaWQwDQYJKoZIhvcNAQELBQADggEBAHVsfCh6cWa1Bk24X/TS8PK6
QwwIaXLi86fr8cokilBw7gUQp7Qex5sdjvptx/U3RyP8QG6RmsQ35xi4bIUfG+Ai
pZw5RD6bCmDq+my7rzatjw6URd2uzbK8LCt/CxciX7qQlp34p9BlnXZdOtulS05G
YX25hFF9HZqWBZMcr6Y4kF7X1rZVYmtxewNJg7t/s9NDxT57PNGpSW0EZiaD/HuG
n+YPBv2YiOCe7DUHUJzIbfxICIEFjNC98Jm9wZWp6a8Z34doPFsZ15hrFrW2Fbcz
WmerPlMUDWMz2BD92BEjDxT3Kp54rbPebzthvIBK4TymqsOlEB6CwrLyou3uOKU=
-----END CERTIFICATE-----`

const KEY_MISMATCH = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCV9k5iB/75Msab
ztdjqWJm7JBRfGIHEp5DJr1IQijuop/nKKUw96G42HpdI3GcCmdujdHd2Qk4BoBJ
zV7gAxFTRr3qYIl8tngN2qb9Af4YioOdw/C0o2zqtRqf7vmRuV+h9zZhDY8wF7qK
W+au9OPYwR+hln3nI9eNS7lw3Z1onZdKKQd5aN32f75kOwaWRn+C5ywkSHNKt3i3
E7qHWapHVS8HNYcYY83txEr2gRQDQKstKOwbt1NkY1p14d1yKA9BmyDDhpF7eKox
hq3oFfSaIIIcNLv8risLyCEscF4L4uwx9kEwqU4/R0YkxNZUznv5L3dtAUIWH0gz
YJTFU14PAgMBAAECggEAOGmLC/KhFoJk1yjkuq91/mzgT18Ai1OUKIOysbN9rWOM
zorqNXT6J8x7n3zdWItLZHnCKHfkMWi0qs6wcYmF43NZrwj4v2ru15tYtRWiTf4R
S/BxJKrTpqlRJjfiN1DqKkYSdUkCA9/xQuoWadtiuN/Rc9pma2R+yj7huBUOCVOn
R5dwtSBxqAtzyHg9gVerffaW0MacEiKOSlhkGPlPbr+WTwavEo8j1KV04658Ixr5
zUpCKC5CpHxJJ2lyferrYo21j39tr3egIX43fothH/POSkA8VgKUjxU5aFrkiGdI
Llio+jBx0KBIsoecb4+K7TNU31nKaO7llWjOeRFvXQKBgQDTUN4Fnuup6qxEKhUB
3acBC9tlUOovaEm0pn79kArXBxgeOlCCpplh5oGaAa4TPmbY9l0J4zez24fffQ7s
f2tZatFOKr/SIEGclnC8Wx3jweTlbIn4lqWgm43DOhqfQhsknw/N2FfbDTN+G/Ur
lKIG0nKA7/LBm8oXUa9mU5KzdQKBgQC1rC9WD6nfOv5xVYkuEbB1NilGRNgwiBEL
HiaiAW7lm+2owJb4hW9Uhs2gsunhczoUwF9TVViONi++kw4pZYbxxSUl5k7aUw4l
CTAhxqx8E3Ko7vZDjJb4mtsyzPR0S8tQfrCGBFAkPaDb8pDNl5ac0hChapT7N/tF
bZ8tSwQu8wKBgALtf+X8Ca/U/IYFPz1DYOj2zRdeQ6BchYjnNaM1t7C6/G6OyEbH
ICDnHKyRkWPa3XnsD+XvK/pl9D/4b5h/O3GFtVir5vR2VfJhczZo3MUnDpDPLCox
jCHphdFKoMvMEqwzN/jWIoF6cVgx8vejm4sUp1l5+ZcNHYOtMgzs439xAoGBAJqv
w5Zpu+BhIOlrRWS+lxsWRMqaL+IS2UA4Kfjjc4N540A+y81MAGFebpOYA2B9dkTZ
D9Gq574fEUQZfoNs+Ru/G0RL93QaJ/8M9bisq4zyGj0RSwp1GM8RO/bjYHntV25w
kOlrnrlc6CyfOwBzREC+9H4cfEHzhrW1A0XTi/pVAoGATsaHVxMsgGciK1+5gmWa
jnHQn32vpsBN4OgU1E1tEZUGXlb41fx74XK7+Vjwdl2Qoui5Ef3zlrMgzNi/5n/H
pep7TvSahN02OsFijZ8n9jfTBoVpY5bnl0rBrTaw76FI+NB4slLxdPdKQMhFp0hp
eXuqvFdhAeFCo6K0ZW2AO28=
-----END PRIVATE KEY-----`

/** Starts any `node:net`-shaped server on an ephemeral loopback port and resolves the port actually bound. */
function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('expected a real TCP address')
      resolve(address.port)
    })
  })
}

/**
 * Builds a raw TLS listener that completes a real handshake and then goes
 * silent forever -- the "accepts a connection and then stalls" scenario a
 * couple of tests below need -- and tracks every socket it accepts so
 * `closeAll` can destroy them explicitly.
 *
 * This tracking exists because `tls.Server`/`net.Server`, unlike
 * `http.Server`, has no `closeAllConnections()`: `server.close()` only
 * stops NEW connections, it never touches a socket already accepted. A
 * fix-round review reproduced exactly this: the first version of the two
 * tests using a bare `createTlsServer(...)` + `server.close()` in `finally`
 * left the server-side socket sitting in CLOSE_WAIT indefinitely once the
 * client aborted, leaking one socket handle per run while the suite stayed
 * green throughout -- the precise "two sockets leaked, suite still green"
 * shape Task 4's own fix rounds warned about. The review also established
 * this was a TEST-FIXTURE leak, not a shipping one: `httpsExternalRequest`
 * destroys its own (client-side) socket correctly on abort, and against a
 * real remote server the far end's own FIN closes the connection this
 * in-process fixture never sends on its own.
 */
function createStallingTlsServer(): { server: TlsServer; closeAll: () => void } {
  const accepted = new Set<TLSSocket>()
  const server = createTlsServer({ key: KEY_A, cert: CERT_A }, (socket) => {
    accepted.add(socket)
    socket.on('close', () => accepted.delete(socket))
    // Accept the TLS connection and then do nothing: no HTTP response,
    // ever. The socket is left open until the client -- or this fixture's
    // own cleanup below -- closes it.
    socket.on('error', () => {})
  })
  return {
    server,
    closeAll: () => {
      for (const socket of accepted) socket.destroy()
      server.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Step 1's given tests: probeExternally against a fully injected `request`,
// with no network and no real TLS at all. These pin the pure decision table
// -- outcome classification, the null-on-failure rule, the timeout, and
// "never throws" -- independent of any real transport.
// ---------------------------------------------------------------------------
describe('external probe', () => {
  it('returns the certificate expiry the handshake actually presented', async () => {
    const r = await probeExternally('alpha.example.invalid', {
      request: async () => ({ status: 200, certExpiresAt: at('2026-12-01T00:00:00Z') }),
    })
    expect(r.outcome).toBe('answering')
    expect(r.certExpiresAt).toEqual(at('2026-12-01T00:00:00Z'))
  })

  it('reports a TLS failure as tls-failed with no expiry, not as a dead app', async () => {
    const r = await probeExternally('alpha.example.invalid', {
      request: async () => {
        throw Object.assign(new Error('bad cert'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
      },
    })
    expect(r.outcome).toBe('tls-failed')
    expect(r.certExpiresAt).toBeNull()
  })

  it('does not report an expiry it never saw', async () => {
    const r = await probeExternally('alpha.example.invalid', {
      request: async () => ({ status: 500, certExpiresAt: null }),
    })
    expect(r.outcome).toBe('not-answering')
    expect(r.certExpiresAt).toBeNull()
  })

  it('times out rather than hanging, and says so', async () => {
    const r = await probeExternally('alpha.example.invalid', {
      request: (_h, signal) =>
        new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
      timeoutMs: 10,
    })
    expect(r.outcome).toBe('not-answering')
  })

  it('never throws', async () => {
    await expect(
      probeExternally('alpha.example.invalid', {
        request: async () => {
          throw new Error('boom')
        },
      }),
    ).resolves.toMatchObject({ outcome: 'not-answering' })
  })

  // A genuine, well-known certificate-verification code OTHER than the
  // hostname-mismatch one used above -- proves the classification is a set
  // membership test, not a hardcoded single string.
  it('classifies an expired-certificate error as tls-failed too', async () => {
    const r = await probeExternally('alpha.example.invalid', {
      request: async () => {
        throw Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' })
      },
    })
    expect(r.outcome).toBe('tls-failed')
    expect(r.certExpiresAt).toBeNull()
  })

  // A stalled-handshake timeout is a NETWORK failure, not a certificate
  // one -- `ERR_TLS_HANDSHAKE_TIMEOUT` starts with `ERR_TLS_` but must NOT
  // be classified as `tls-failed`, which is exactly why classification here
  // is an explicit set of certificate-verification codes rather than a
  // `code.startsWith('ERR_TLS_')` prefix check.
  it('does not classify a stalled-handshake timeout as a certificate failure', async () => {
    const r = await probeExternally('alpha.example.invalid', {
      request: async () => {
        throw Object.assign(new Error('handshake timed out'), { code: 'ERR_TLS_HANDSHAKE_TIMEOUT' })
      },
    })
    expect(r.outcome).toBe('not-answering')
  })
})

// ---------------------------------------------------------------------------
// The real transport (httpsExternalRequest), against real listeners.
//
// Fix round 2 of Task 4 found tests that injected a fake `fetch` and
// asserted on the headers ARGUMENT, never on what reached the wire; they
// passed while the real request silently dropped the `Host` header. Every
// test below runs the real `httpsExternalRequest` -- real DNS resolution is
// unavailable for a loopback fixture, but the TLS handshake, the
// certificate exchange, and the HTTP exchange are all genuine -- against a
// real `node:https`/`node:tls` listener, and asserts on what that listener
// actually received or on what the handshake actually returned.
// ---------------------------------------------------------------------------
describe('the real external transport (httpsExternalRequest), against real listeners', () => {
  it('reads the certificate expiry from the real TLS handshake, not a fixed value', async () => {
    const server = createHttpsServer({ key: KEY_A, cert: CERT_A }, (_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const port = await listenEphemeral(server)
    try {
      const controller = new AbortController()
      const r = await httpsExternalRequest('127.0.0.1', controller.signal, { port, ca: CERT_A })
      expect(r.status).toBe(200)
      expect(r.certExpiresAt).toEqual(CERT_A_EXPIRY)
    } finally {
      server.close()
    }
  })

  // The discriminating half of the pair above: a DIFFERENT certificate,
  // served by a DIFFERENT listener, must yield a DIFFERENT expiry out of
  // the exact same code path. A hardcoded or memoised return value would
  // pass the test above and fail this one.
  it('reads a different expiry from a different certificate -- proving extraction is not hardcoded', async () => {
    const server = createHttpsServer({ key: KEY_B, cert: CERT_B }, (_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const port = await listenEphemeral(server)
    try {
      const controller = new AbortController()
      const r = await httpsExternalRequest('127.0.0.1', controller.signal, { port, ca: CERT_B })
      expect(r.status).toBe(200)
      expect(r.certExpiresAt).toEqual(CERT_B_EXPIRY)
      expect(r.certExpiresAt).not.toEqual(CERT_A_EXPIRY)
    } finally {
      server.close()
    }
  })

  it('does not follow a redirect: the 3xx is reported as-is, and the server sees exactly one request', async () => {
    let requestCount = 0
    const server = createHttpsServer({ key: KEY_A, cert: CERT_A }, (_req, res) => {
      requestCount += 1
      res.writeHead(302, { Location: 'https://elsewhere.example.invalid/' })
      res.end()
    })
    const port = await listenEphemeral(server)
    try {
      const controller = new AbortController()
      const r = await httpsExternalRequest('127.0.0.1', controller.signal, { port, ca: CERT_A })
      expect(r.status).toBe(302)
      expect(requestCount).toBe(1)
    } finally {
      server.close()
    }
  })

  it('identifies itself with a distinct User-Agent', async () => {
    const seenAgents: Array<string | undefined> = []
    const server = createHttpsServer({ key: KEY_A, cert: CERT_A }, (req, res) => {
      seenAgents.push(req.headers['user-agent'])
      res.writeHead(200)
      res.end()
    })
    const port = await listenEphemeral(server)
    try {
      const controller = new AbortController()
      await httpsExternalRequest('127.0.0.1', controller.signal, { port, ca: CERT_A })
      expect(seenAgents).toEqual(['bevora-ops-external-probe/1'])
    } finally {
      server.close()
    }
  })

  it('reports 500 and 502 correctly through the shared classification, end to end against a real listener', async () => {
    for (const status of [500, 502]) {
      const server = createHttpsServer({ key: KEY_A, cert: CERT_A }, (_req, res) => {
        res.writeHead(status)
        res.end()
      })
      const port = await listenEphemeral(server)
      const deps: ExternalDeps = {
        request: (hostname, signal) => httpsExternalRequest(hostname, signal, { port, ca: CERT_A }),
      }
      try {
        const r = await probeExternally('127.0.0.1', deps)
        expect(r.status).toBe(status)
        expect(r.outcome).toBe(status === 502 ? 'proxy-no-upstream' : 'not-answering')
        // A real 5xx response still completed a real handshake -- the
        // certificate WAS observed, so its expiry is reported.
        expect(r.certExpiresAt).toEqual(CERT_A_EXPIRY)
      } finally {
        server.close()
      }
    }
  })

  it('reports 401 as answering -- a login wall is a working application', async () => {
    const server = createHttpsServer({ key: KEY_A, cert: CERT_A }, (_req, res) => {
      res.writeHead(401)
      res.end()
    })
    const port = await listenEphemeral(server)
    const deps: ExternalDeps = {
      request: (hostname, signal) => httpsExternalRequest(hostname, signal, { port, ca: CERT_A }),
    }
    try {
      const r = await probeExternally('127.0.0.1', deps)
      expect(r.outcome).toBe('answering')
      expect(r.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('classifies a real self-signed, untrusted certificate as tls-failed, with no expiry -- not as a dead application', async () => {
    // No `ca` override: the default trust store rejects this certificate,
    // exactly as a real browser would reject an untrusted certificate on
    // the open internet.
    const server = createHttpsServer({ key: KEY_A, cert: CERT_A }, (_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const port = await listenEphemeral(server)
    const deps: ExternalDeps = {
      request: (hostname, signal) => httpsExternalRequest(hostname, signal, { port }),
    }
    try {
      const r = await probeExternally('127.0.0.1', deps)
      expect(r.outcome).toBe('tls-failed')
      expect(r.certExpiresAt).toBeNull()
      expect(r.status).toBeNull()
    } finally {
      server.close()
    }
  })

  // Isolates the OTHER shape of a real certificate failure: an otherwise
  // trusted certificate (via `ca`) that simply does not name the address
  // being dialled. Observed directly against this exact listener before
  // writing the assertion: Node raises `ERR_TLS_CERT_ALTNAME_INVALID` here
  // with NO explicit `servername` required -- the obvious-looking
  // workaround of setting `servername` to force a match was unnecessary
  // and would have been wrong, since it would suppress the very check this
  // test exists to exercise.
  it('classifies a real hostname/certificate mismatch as tls-failed, with no expiry', async () => {
    const server = createHttpsServer({ key: KEY_MISMATCH, cert: CERT_MISMATCH }, (_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const port = await listenEphemeral(server)
    const deps: ExternalDeps = {
      request: (hostname, signal) => httpsExternalRequest(hostname, signal, { port, ca: CERT_MISMATCH }),
    }
    try {
      const r = await probeExternally('127.0.0.1', deps)
      expect(r.outcome).toBe('tls-failed')
      expect(r.certExpiresAt).toBeNull()
    } finally {
      server.close()
    }
  })

  it('classifies a real connection refusal as not-answering, not tls-failed', async () => {
    // Port 1 is privileged and unused in any normal test sandbox: a
    // genuine ECONNREFUSED, not a simulated one.
    const deps: ExternalDeps = {
      request: (hostname, signal) => httpsExternalRequest(hostname, signal, { port: 1 }),
    }
    const r = await probeExternally('127.0.0.1', deps)
    expect(r.outcome).toBe('not-answering')
    expect(r.certExpiresAt).toBeNull()
  })

  // The scenario design question 1 asks about directly: a listener that
  // completes a REAL TLS handshake -- so this is not a certificate
  // problem, and must not read as one -- and then simply never sends an
  // HTTP response. Built on raw `node:tls`, not `node:https`, specifically
  // so the handshake can succeed with no HTTP framing following it at all.
  it('is bounded in time when a listener completes TLS and then stalls, and does not classify the stall as a certificate failure', async () => {
    const { server, closeAll } = createStallingTlsServer()
    const port = await listenEphemeral(server)
    const deps: ExternalDeps = {
      request: (hostname, signal) => httpsExternalRequest(hostname, signal, { port, ca: CERT_A }),
      timeoutMs: 100,
    }
    try {
      const startedAt = Date.now()
      const r = await probeExternally('127.0.0.1', deps)
      expect(r.outcome).toBe('not-answering')
      expect(r.certExpiresAt).toBeNull()
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    } finally {
      closeAll()
    }
  })

  it('aborts a real in-flight request promptly when the signal fires, rather than waiting for the far end', async () => {
    const { server, closeAll } = createStallingTlsServer()
    const port = await listenEphemeral(server)
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 50)
      const startedAt = Date.now()
      await expect(httpsExternalRequest('127.0.0.1', controller.signal, { port, ca: CERT_A })).rejects.toThrow()
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    } finally {
      closeAll()
    }
  })

  // Fix round 1: a bare `createTlsServer(...)` + `server.close()` -- what
  // the two tests above used to do -- leaks the server-side socket into
  // CLOSE_WAIT forever once the client aborts, because `tls.Server` (unlike
  // `http.Server`) has no `closeAllConnections()` and `close()` alone never
  // touches an already-accepted socket. This test asserts that property
  // directly, the way `agent/src/probe.test.ts`'s on-box drain test does,
  // rather than trusting the comment on `createStallingTlsServer` above.
  it('does not leak a server-side socket per stall-and-abort cycle', async () => {
    async function stallThenAbort(): Promise<void> {
      const { server, closeAll } = createStallingTlsServer()
      const port = await listenEphemeral(server)
      try {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 20)
        await expect(httpsExternalRequest('127.0.0.1', controller.signal, { port, ca: CERT_A })).rejects.toThrow()
        // Give the server a moment to have actually registered the
        // accepted socket before cleanup runs.
        await new Promise((r) => setTimeout(r, 20))
      } finally {
        closeAll()
      }
    }
    // One warm-up cycle so its own setup (real, not a leak) doesn't
    // pollute the baseline measurement below.
    await stallThenAbort()
    await new Promise((r) => setTimeout(r, 50))
    const before = countActiveSockets()
    const N = 10
    for (let i = 0; i < N; i++) {
      await stallThenAbort()
    }
    // Give destroyed sockets a moment to actually finish closing.
    await new Promise((r) => setTimeout(r, 150))
    const after = countActiveSockets()
    // With the fix this stays flat; without it, one server-side socket
    // leaks per cycle, so growth tracks N. A bound well below N
    // discriminates cleanly either way.
    expect(after - before).toBeLessThan(N / 2)
  })
})

// ---------------------------------------------------------------------------
// Task 9's substantive fix, deferred from Task 8: the scheme `probeExternally`
// asks for must come from `listensTls`, never be assumed. Pure decision-table
// tests first (no network), then the real transport proving the two schemes
// actually reach different servers.
// ---------------------------------------------------------------------------
describe('probeExternally chooses its scheme from listensTls, never assumes https', () => {
  function capturingDeps(): { deps: ExternalDeps; seen: ExternalScheme[] } {
    const seen: ExternalScheme[] = []
    return {
      deps: {
        request: async (_hostname, _signal, scheme) => {
          seen.push(scheme)
          return { status: 200, certExpiresAt: null }
        },
      },
      seen,
    }
  }

  it('dials https when listensTls is true (confirmed TLS)', async () => {
    const { deps, seen } = capturingDeps()
    await probeExternally('alpha.example.invalid', deps, true)
    expect(seen).toEqual(['https'])
  })

  it('dials http when listensTls is false (confirmed no TLS)', async () => {
    const { deps, seen } = capturingDeps()
    await probeExternally('alpha.example.invalid', deps, false)
    expect(seen).toEqual(['http'])
  })

  it('dials https when listensTls is null (undetermined) -- the safe default, not a guess of "no TLS"', async () => {
    const { deps, seen } = capturingDeps()
    await probeExternally('alpha.example.invalid', deps, null)
    expect(seen).toEqual(['https'])
  })

  it('dials https when listensTls is omitted entirely -- every caller written before this parameter existed', async () => {
    const { deps, seen } = capturingDeps()
    await probeExternally('alpha.example.invalid', deps)
    expect(seen).toEqual(['https'])
  })
})

describe('httpsExternalRequest, real transport: scheme selects http vs https, not just a header', () => {
  it('reaches a real plain-HTTP listener when scheme is "http", with no TLS handshake and no certificate', async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200)
      res.end('plain-http-ok')
    })
    const port = await listenEphemeral(server)
    try {
      const controller = new AbortController()
      const r = await httpsExternalRequest('127.0.0.1', controller.signal, { scheme: 'http', port })
      expect(r.status).toBe(200)
      expect(r.certExpiresAt).toBeNull()
    } finally {
      server.close()
    }
  })

  // A genuinely live version of this test (bind a real listener on port 80,
  // dial with NO port override, confirm it's reached) would need root to
  // BIND under 1024 -- confirmed directly in this sandbox (a plain
  // `http.Server.listen(80, ...)` here raises `EACCES`), and the same is
  // true of most CI runners, so that version cannot run portably. A version
  // that instead dials the real default port with nothing listening there
  // does NOT discriminate: a connection refused at the TCP layer happens
  // before any HTTP or TLS exchange either way, so "wrongly defaulted to
  // 443 instead of 80" and "correctly defaulted to 80" are BOTH
  // `not-answering` against an empty sandbox network -- checked directly by
  // mutating the default to 443 and confirming this exact shape of
  // assertion still passed. This is a source check instead: a real
  // regression test for the literal, paired with the tests above and below,
  // which already prove (against real listeners) that the `http` scheme
  // reaches a real server end-to-end and reports no certificate -- what
  // those tests cannot prove, without root, is the specific default PORT
  // number.
  it('the http branch defaults its port to 80, distinct from the https branch\'s 443', () => {
    const path = fileURLToPath(new URL('./external-probe.ts', import.meta.url))
    const source = readFileSync(path, 'utf8')
    expect(source).toMatch(/port:\s*overrides\.port\s*\?\?\s*80,/)
    expect(source).toMatch(/port:\s*overrides\.port\s*\?\?\s*443,/)
  })

  it('identifies itself with the same distinct User-Agent over plain HTTP as it does over HTTPS', async () => {
    const seenAgents: Array<string | undefined> = []
    const server = createHttpServer((req, res) => {
      seenAgents.push(req.headers['user-agent'])
      res.writeHead(200)
      res.end()
    })
    const port = await listenEphemeral(server)
    try {
      const controller = new AbortController()
      await httpsExternalRequest('127.0.0.1', controller.signal, { scheme: 'http', port })
      expect(seenAgents).toEqual(['bevora-ops-external-probe/1'])
    } finally {
      server.close()
    }
  })

  // The central proof: the exact false-green scenario Task 9's brief
  // describes, reproduced with two REAL listeners. `httpsServer` stands in
  // for "whatever server block actually owns port 443 on a multi-tenant
  // host" -- it answers ANY TLS connection that reaches it, for a hostname
  // it was never configured for. `httpServer` stands in for the real,
  // deliberately-plain-HTTP vhost. A hostname with `listensTls: false` must
  // reach ONLY the plain-HTTP server -- never the TLS one -- and a hostname
  // with `listensTls: true` must reach ONLY the TLS one.
  //
  // Each server counts its OWN hits, inside its own request handler -- this
  // is what makes the assertion discriminate: an EARLIER draft of this test
  // instead made a second, independent request to each port after the fact
  // and compared bodies, which cannot fail no matter which server
  // `probeExternally` actually dialled, because it never observes that call
  // at all. Counting hits INSIDE the handler that `probeExternally`'s own
  // request either does or does not reach is what ties the assertion to the
  // real call.
  it('a plain-HTTP-only hostname never reaches the TLS listener standing in for "a different tenant on port 443"', async () => {
    let httpsHits = 0
    let httpHits = 0
    const httpsServer = createHttpsServer({ key: KEY_A, cert: CERT_A }, (_req, res) => {
      httpsHits += 1
      res.writeHead(200)
      res.end()
    })
    const httpServer = createHttpServer((_req, res) => {
      httpHits += 1
      res.writeHead(200)
      res.end()
    })
    const httpsPort = await listenEphemeral(httpsServer)
    const httpPort = await listenEphemeral(httpServer)

    // Stands in for the real production wiring
    // (`probe-scheduler.ts`'s `productionDeps`): the scheme
    // `probeExternally` decides from `listensTls` is the ONLY thing that
    // picks which real port gets dialled.
    const deps: ExternalDeps = {
      request: (hostname, signal, scheme) =>
        httpsExternalRequest(hostname, signal, {
          scheme,
          port: scheme === 'http' ? httpPort : httpsPort,
          ca: CERT_A,
        }),
    }

    try {
      const plainResult = await probeExternally('127.0.0.1', deps, false)
      expect(plainResult.outcome).toBe('answering')
      expect(httpHits).toBe(1)
      expect(httpsHits).toBe(0) // never touched the "wrong tenant" listener

      const tlsResult = await probeExternally('127.0.0.1', deps, true)
      expect(tlsResult.outcome).toBe('answering')
      expect(httpsHits).toBe(1)
      expect(httpHits).toBe(1) // unchanged from the first call
    } finally {
      httpsServer.close()
      httpServer.close()
    }
  })
})
