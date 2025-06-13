import { useEffect, useState, useRef } from "react";
import io from "socket.io-client";
import "./App.css";

const socket = io(import.meta.env.VITE_BACKEND_URL || "http://localhost:3000");


function App() {
  const [nome, setNome] = useState("");
  const [sala, setSala] = useState("teste");
  const [categoria, setCategoria] = useState("");
  const [usuarios, setUsuarios] = useState({});
  const [chute, setChute] = useState("");
  const [mensagens, setMensagens] = useState([]);
  const chatRef = useRef(null);

  useEffect(() => {
    socket.on("connect", () => {
      // Conectado
    });

    socket.on("dadosSala", (dados) => {
      setCategoria(dados.categoria);
    });

    socket.on("usuariosAtualizados", (atualizados) => {
      setUsuarios(atualizados);
    });

    socket.on("mensagem", (mensagem) => {
      setMensagens((msgs) => [...msgs, mensagem]);
    });

    return () => {
      socket.off("connect");
      socket.off("dadosSala");
      socket.off("usuariosAtualizados");
      socket.off("mensagem");
    };
  }, []);

  // Scroll automático do chat
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTo({
        top: chatRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [mensagens]);

  function entrar() {
    if (!nome.trim()) return;
    socket.emit("entrarSala", { salaId: sala, nome });
  }

  function enviarChute(e) {
    e.preventDefault();
    if (!chute.trim()) return;
    socket.emit("chutar", { salaId: sala, chute });
    setChute("");
  }

  return (
    <div className="app-container">
      {!categoria && (
        <div className="login">
          <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Seu nome" className="input-login" />
          <button onClick={entrar} className="btn-login">
            Entrar
          </button>
        </div>
      )}
      {categoria && (
        <>
          <header className="header">
            <h1>Categoria: {categoria}</h1>
          </header>

          <div className="main-content">
            <aside className="sidebar">
              <h2>Jogadores</h2>
              <ul>
                {Object.entries(usuarios).map(([id, u]) => (
                  <li key={id}>
                    {u.nome}: {u.pontos} pts
                  </li>
                ))}
              </ul>
            </aside>

            <section className="chat-section">
              <div ref={chatRef} className="chat-messages">
                {mensagens.map((msg, i) => (
                  <div
                    key={i}
                    className={`chat-msg ${msg.nome === "Sistema" ? "chat-sistema" : ""} 
                ${msg.acertou ? "chat-acerto" : ""}`}
                  >
                    <strong>{msg.nome}:</strong> {msg.texto} {msg.acertou && "✅"}
                  </div>
                ))}
              </div>

              <form onSubmit={enviarChute} className="chat-form">
                <input value={chute} onChange={(e) => setChute(e.target.value)} placeholder="Seu chute" className="chat-input" />
                <button type="submit" className="chat-btn">
                  Enviar
                </button>
              </form>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
