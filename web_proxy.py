import asyncio
import websockets

TCP_HOST = '127.0.0.1'
TCP_PORT = 5555
WS_HOST  = '0.0.0.0'
WS_PORT  = 8080

# 100 MB read buffer — needed for large base64 file packets
# asyncio's default is only 64 KB which causes LimitOverrunError on image uploads
READ_LIMIT = 100 * 1024 * 1024

async def tcp_to_ws(tcp_reader, ws):
    """Read from TCP server and forward to WebSocket client."""
    try:
        while True:
            # readline() respects the READ_LIMIT set in open_connection()
            line = await tcp_reader.readline()
            if not line:
                break
            msg = line.decode('utf-8').strip()
            if msg:
                await ws.send(msg)
    except Exception as e:
        print(f"[tcp->ws] Error: {e}")
    finally:
        await ws.close()

async def ws_to_tcp(ws, tcp_writer):
    """Read from WebSocket client and forward to TCP server."""
    try:
        async for message in ws:
            data = message.encode('utf-8') + b'\n'
            tcp_writer.write(data)
            await tcp_writer.drain()
    except Exception as e:
        print(f"[ws->tcp] Error: {e}")
    finally:
        tcp_writer.close()

async def handle_client(ws):
    print(f"[*] New WebSocket client: {ws.remote_address}")
    try:
        # *** The limit= param raises the asyncio StreamReader internal buffer.
        # Without this, readline() raises LimitOverrunError on large file packets
        # (default is only 64KB — not enough for a base64-encoded image).
        tcp_reader, tcp_writer = await asyncio.open_connection(
            TCP_HOST, TCP_PORT, limit=READ_LIMIT
        )
    except Exception as e:
        print(f"[!] Failed to connect to TCP server: {e}")
        await ws.close()
        return

    task1 = asyncio.create_task(tcp_to_ws(tcp_reader, ws))
    task2 = asyncio.create_task(ws_to_tcp(ws, tcp_writer))

    done, pending = await asyncio.wait(
        [task1, task2], return_when=asyncio.FIRST_COMPLETED
    )
    for task in pending:
        task.cancel()

    try:
        tcp_writer.close()
        await tcp_writer.wait_closed()
    except Exception:
        pass
    print(f"[*] Connection closed for {ws.remote_address}")

async def main():
    print("======================================================")
    print(f"  WebSocket Proxy Bridge")
    print(f"  WS  <- ws://{WS_HOST}:{WS_PORT}")
    print(f"  TCP -> {TCP_HOST}:{TCP_PORT}")
    print(f"  Max message size: {READ_LIMIT // (1024*1024)} MB")
    print("======================================================")

    async with websockets.serve(
        handle_client, WS_HOST, WS_PORT,
        max_size=READ_LIMIT   # WebSocket inbound message limit (matches TCP limit)
    ):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Shutting down proxy.")
