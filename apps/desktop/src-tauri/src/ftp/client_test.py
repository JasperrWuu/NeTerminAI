"""Real standard-library FTP client integration; only invoked by the ignored Rust test."""
import ftplib
import io
import os
from pathlib import Path
import socket
import struct
import sys

host, port, root = sys.argv[1], int(sys.argv[2]), Path(sys.argv[3])

def connect():
    client = ftplib.FTP()
    client.connect(host, port, timeout=5)
    client.login("admin - 测试", " pass word ")
    client.set_pasv(False)
    return client

with connect() as ftp, connect() as other:
    data = bytes(range(256)) * 8192
    for i in range(3):
        name = f"transfer-{i}.bin"
        assert ftp.storbinary(f"STOR {name}", io.BytesIO(data)).startswith("226")
        assert (root / name).read_bytes() == data
        received = io.BytesIO()
        assert ftp.retrbinary(f"RETR {name}", received.write).startswith("226")
        assert received.getvalue() == data
        assert ftp.size(name) == len(data)
        assert ftp.voidcmd("NOOP").startswith("200")
    assert "transfer-0.bin" in ftp.nlst()
    assert ftp.storlines("STOR text.txt", io.BytesIO(b"one\ntwo\n")).startswith("226")
    text_lines = []
    assert ftp.retrlines("RETR text.txt", text_lines.append).startswith("226")
    assert text_lines == ["one", "two"]
    lines = []
    ftp.retrlines("LIST", lines.append)
    assert any("transfer-0.bin" in line for line in lines)
    ftp.cwd("sub")
    assert ftp.pwd() == "/sub" and other.pwd() == "/"
    ftp.cwd("..")
    for command in ("PASV", "EPSV"):
        try:
            ftp.sendcmd(command)
            raise AssertionError("Passive mode was accepted")
        except ftplib.error_perm as error:
            assert str(error).startswith("502")
        assert ftp.voidcmd("NOOP").startswith("200")
    upload = ftp.transfercmd("STOR aborted.bin")
    upload.sendall(b"partial")
    upload.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("hh" if os.name == "nt" else "ii", 1, 0))
    upload.close()
    try:
        ftp.voidresp()
        raise AssertionError("Interrupted upload incorrectly returned success")
    except ftplib.error_temp as error:
        assert str(error).startswith("426"), str(error)
    assert ftp.voidcmd("NOOP").startswith("200")
print("ftplib: 3 x 2 MiB active PUT/GET, SIZE/LIST/NLST, client isolation, passive rejection, interrupted upload: passed")
