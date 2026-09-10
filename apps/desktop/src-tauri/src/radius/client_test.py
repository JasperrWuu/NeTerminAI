"""Independent RFC packet client using Python hashlib, not the Rust codec."""
import hashlib, hmac, os, socket, struct, sys
secret = b"admin@123"
host, port = sys.argv[1], int(sys.argv[2])
sock = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(2)
sequence = 0
def attr(t, v): return bytes([t, len(v)+2]) + v
def attributes(packet):
    offset = 20
    result = []
    while offset < len(packet):
        kind, size = packet[offset:offset+2]
        result.append((kind, packet[offset+2:offset+size], offset+2))
        offset += size
    return result
def request(password=None, state=None, chap=False, mac=True):
    global sequence
    sequence += 1
    auth = os.urandom(16)
    attrs = attr(1, "任意用户".encode()) + attr(32, b"test-nas")
    if password is not None:
        plain = password + b"\0" * ((-len(password)) % 16)
        cipher = b""; previous = auth
        for offset in range(0, len(plain), 16):
            previous = bytes(a ^ b for a, b in zip(plain[offset:offset+16], hashlib.md5(secret + previous).digest()))
            cipher += previous
        attrs += attr(2, cipher)
    if chap: attrs += attr(3, b"\x07" + os.urandom(16)) + attr(60, os.urandom(16))
    if state: attrs += attr(24, state)
    attrs += attr(33, b"proxy-one") + attr(33, b"proxy-two")
    if mac: attrs += attr(80, bytes(16))
    packet = bytes([1, sequence]) + struct.pack("!H", 20+len(attrs)) + auth + attrs
    if mac: packet = packet[:-16] + hmac.new(secret, packet, hashlib.md5).digest()
    return packet
def exchange(packet, expected):
    sock.sendto(packet, (host, port))
    reply = sock.recv(4096)
    assert reply[0] == expected and reply[1] == packet[1]
    assert len(reply) == struct.unpack("!H", reply[2:4])[0]
    signed = reply[:4] + packet[4:20] + reply[20:]
    assert hmac.compare_digest(reply[4:20], hashlib.md5(signed + secret).digest())
    attrs = attributes(reply)
    assert [v for t,v,_ in attrs if t == 33] == [b"proxy-one", b"proxy-two"]
    for t, value, offset in attrs:
        if t == 80:
            zeroed = signed[:offset] + bytes(16) + signed[offset+16:]
            assert hmac.compare_digest(value, hmac.new(secret, zeroed, hashlib.md5).digest())
    return reply
exchange(request(b"admin@123"), 2)
exchange(request(b"admin@123", mac=False), 2)
exchange(request(b"wrong-password-over-sixteen-bytes"), 3)
exchange(request(chap=True), 2)
initial = request(b"Admin@123")
challenge = exchange(initial, 11)
assert exchange(initial, 11) == challenge
attrs = {t: value for t,value,_ in attributes(challenge)}
code = attrs[18].split(b": ")[1]
assert len(code) == 6 and code.isalnum()
completed = request(code, attrs[24])
accepted = exchange(completed, 2)
assert exchange(completed, 2) == accepted
exchange(request(code, attrs[24]), 3)
challenge = exchange(request(b"Admin@123"), 11)
state = dict((t,v) for t,v,_ in attributes(challenge))[24]
exchange(request(b"wrong", state), 3)
tampered = bytearray(request(b"admin@123")); tampered[-1] ^= 1
sock.sendto(tampered, (host, port))
try:
    sock.recv(4096)
    raise AssertionError("invalid Message-Authenticator accepted")
except socket.timeout: pass
sock.close()
print(host, "PAP, CHAP lab policy, challenge/replay, Proxy-State, MD5/HMAC signatures: passed")
