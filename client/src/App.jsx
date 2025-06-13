import { useEffect, useState, useRef } from "react";
import io from "socket.io-client";
import "./App.css";

const somAcerto = new Audio("/sounds/acerto.mp3");
const somErroProximo = new Audio("/sounds/erro_proximo.mp3");
const somNovaRodada = new Audio("/sounds/nova_rodada.mp3");
const somFimJogo = new Audio("/sounds/fim_jogo.mp3");

const socket = io(import.meta.env.VITE_BACKEND_URL || "http://localhost:3000");

function App() {
  const [nome, setNome] = useState("");
  const [sala, setSala] = useState("teste");
  const [categoria, setCategoria] = useState("");
  const [acertadas, setAcertadas] = useState([]);
  const [usuarios, setUsuarios] = useState({});
  const [chute, setChute] = useState("");
  const [mensagens, setMensagens] = useState([]);
  const [tempoRestante, setTempoRestante] = useState(0);
  const [rodada, setRodada] = useState(1);
  const [emJogo, setEmJogo] = useState(false);
  const [showCategoria, setShowCategoria] = useState(false);
  const [tempoRespostaJogadores, setTempoRespostaJogadores] = useState({});
  const [jogoFinalizado, setJogoFinalizado] = useState(false);
  const [limiteSala, setLimiteSala] = useState(null);
  const [faqAberto, setFaqAberto] = useState(false);

  const chatRef = useRef(null);
  const timerInterval = useRef(null);
  const delayCategoriaTimeout = useRef(null);

  // Função para tocar sons com segurança (tratando permissões e erros)
  function tocarSom(audio) {
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    audio.play().catch(() => {
      // erro comum: autoplay bloqueado, ignorar
    });
  }

  useEffect(() => {
    const ultimaMsg = mensagens[mensagens.length - 1];
    if (ultimaMsg?.nome === "Sistema" && ultimaMsg.texto.includes("Rodada") && ultimaMsg.texto.includes("iniciada")) {
      setTempoRestante(90); // ou 60 se mudar depois
    }
  }, [mensagens]);

  useEffect(() => {
    // Escuta eventos do socket
    socket.on("connect", () => {
      // Conectou
    });

    socket.on("dadosSala", (dados) => {
      setLimiteSala(dados.limiteSala || null);
      setCategoria(dados.categoria);
      setAcertadas(dados.acertadas || []);
      setRodada(dados.rodada || 1);
      setEmJogo(true);
      setTempoRespostaJogadores({});
      // toca som nova rodada
      tocarSom(somNovaRodada);
    });

    socket.on("atualizarAcertadas", (listaAtualizada) => {
      setAcertadas(listaAtualizada);
    });

    socket.on("usuariosAtualizados", (atualizados) => {
      // Ordena por pontos desc
      const sorted = Object.entries(atualizados)
        .sort((a, b) => b[1].pontos - a[1].pontos)
        .reduce((acc, [id, u]) => {
          acc[id] = u;
          return acc;
        }, {});
      setUsuarios(sorted);
    });

    socket.on("mensagem", (msg) => {
      let novaMsg = { ...msg };

      if (msg.acertou && msg.tempoResposta != null) {
        novaMsg.texto = `${msg.nome} acertou "${msg.texto}" em ${msg.tempoResposta} segundos`;
        tocarSom(somAcerto);
        setTempoRespostaJogadores((t) => ({
          ...t,
          [msg.nome]: msg.tempoResposta,
        }));
      } else if (msg.perto && msg.destinatario === nome) {
        novaMsg.texto = `"${msg.texto}" do usuário ${msg.nome} está perto`;
        tocarSom(somErroProximo);
      }

      setMensagens((msgs) => [...msgs, novaMsg]);
    });

    socket.on("fimJogo", (top3) => {
      setJogoFinalizado(true);
      setEmJogo(false);
      tocarSom(somFimJogo);

      const textoTop3 = top3.map((u, i) => `${i + 1}º ${u.nome} - ${u.pontos} pts`).join("\n");
      setMensagens((msgs) => [...msgs, { nome: "Sistema", texto: `Fim de jogo! Top 3:\n${textoTop3}` }]);
    });

    socket.on("salaCheia", () => {
      alert("A sala está cheia. Tente outra sala.");
    });

    socket.on("disconnect", () => {
      resetarEstado();
    });

    socket.on("removidoInatividade", () => {
      alert("Você foi removido por inatividade.");
      window.location.href = "/";
    });

    return () => {
      // Cleanup eventos e timers
      socket.off("connect");
      socket.off("dadosSala");
      socket.off("atualizarAcertadas");
      socket.off("usuariosAtualizados");
      socket.off("mensagem");
      socket.off("fimJogo");
      socket.off("salaCheia");
      socket.off("disconnect");
      socket.off("removidoInatividade");

      clearInterval(timerInterval.current);
      clearTimeout(delayCategoriaTimeout.current);
    };
  }, [nome]);

  useEffect(() => {
    // Controla timer de contagem regressiva
    if (!emJogo) {
      clearInterval(timerInterval.current);
      setTempoRestante(0);
      return;
    }

    // Tenta extrair tempo restante da última mensagem do sistema
    const ultimoMsg = mensagens[mensagens.length - 1];
    if (ultimoMsg && ultimoMsg.nome === "Sistema" && /Você tem \d+ segundos/.test(ultimoMsg.texto)) {
      const match = ultimoMsg.texto.match(/Você tem (\d+)\s+segundos/);
      if (match) {
        let segs = parseInt(match[1], 10);
        setTempoRestante(segs);

        clearInterval(timerInterval.current);
        timerInterval.current = setInterval(() => {
          setTempoRestante((t) => {
            if (t <= 1) {
              clearInterval(timerInterval.current);
              return 0;
            }
            return t - 1;
          });
        }, 1000);
      }
    }
  }, [mensagens, emJogo]);

  useEffect(() => {
    // Scroll automático para o final do chat
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [mensagens]);

  function resetarEstado() {
    setCategoria("");
    setAcertadas([]);
    setUsuarios({});
    setMensagens([]);
    setRodada(1);
    setEmJogo(false);
    setTempoRestante(0);
    setShowCategoria(false);
    setTempoRespostaJogadores({});
    setJogoFinalizado(false);
    setLimiteSala(null);
    clearInterval(timerInterval.current);
    clearTimeout(delayCategoriaTimeout.current);
  }

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

  function sair() {
    socket.disconnect();
    resetarEstado();
  }

  return (
    <div className="app-container">
      {!categoria && !jogoFinalizado && (
        <div className="login">
          <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Seu nome" className="input-login" />
          <input value={sala} onChange={(e) => setSala(e.target.value)} placeholder="Sala" className="input-login" />
          <button onClick={entrar} className="btn-login" disabled={limiteSala && Object.keys(usuarios).length >= limiteSala}>
            Entrar
          </button>
          {limiteSala && Object.keys(usuarios).length >= limiteSala && <p className="aviso">Sala cheia, escolha outra.</p>}
          <button className="btn-faq" onClick={() => setFaqAberto(true)}>
            FAQ / Como jogar
          </button>
        </div>
      )}

      {categoria && (
        <>
          <header className="header">
            <div className="header-esquerda">
              <h1>Categoria: {categoria}</h1>
            </div>
            {/* Removido o header-direita */}
          </header>

          <div className="main-content">
            <aside className="sidebar esquerda">
              <h2>Jogadores</h2>
              <ul>
                {Object.entries(usuarios).map(([id, u]) => (
                  <li key={id} className={u.bonusPrimeiro ? "destaque-primeiro" : ""} title={`Tempo para acertar: ${tempoRespostaJogadores[u.nome] != null ? tempoRespostaJogadores[u.nome] + "s" : "N/A"}`}>
                    {u.nome}: {u.pontos} pts {u.bonusPrimeiro && <span className="badge">1º!</span>}
                    {tempoRespostaJogadores[u.nome] != null && <small> ({tempoRespostaJogadores[u.nome]}s)</small>}
                  </li>
                ))}
              </ul>

              <h3>Palavras acertadas:</h3>
              <ul className="palavras-acertadas">
                {acertadas.length === 0 && <li>Nenhuma palavra acertada ainda</li>}
                {acertadas.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </aside>

            <section className="chat-section">
              <div ref={chatRef} className="chat-messages" aria-live="polite" aria-atomic="false">
                {mensagens.map((msg, i) => (
                  <div key={i} className={`chat-msg ${msg.nome === "Sistema" ? "chat-sistema" : ""} ${msg.acertou ? "chat-acerto" : ""} ${msg.perto ? "chat-perto" : ""}`}>
                    <strong>{msg.nome}:</strong> {msg.texto} {msg.acertou && "✅"}
                    {msg.perto && <em> (Você está perto!)</em>}
                  </div>
                ))}
              </div>

              <form onSubmit={enviarChute} className="chat-form">
                <input value={chute} onChange={(e) => setChute(e.target.value)} placeholder="Seu chute" className="chat-input" disabled={!emJogo} autoComplete="off" spellCheck={false} />
                <button type="submit" className="chat-btn" disabled={!emJogo}>
                  Enviar
                </button>
              </form>
            </section>

            {/* Barra lateral direita */}
            <aside className="sidebar direita">
              <div className="rodada-info">
                <span>Rodada: {rodada} / 10</span>
                <div className="timer-container">
                  <span className="timer-barra" aria-label="Barra de tempo restante">
                    <span
                      key={tempoRestante} // forçar "reset" da animação ao reiniciar tempo
                      className="timer-progresso"
                      style={{
                        width: `${Math.max((tempoRestante / 90) * 100, 1)}%`, // nunca menor que 1%
                        backgroundColor:
                          tempoRestante > 45
                            ? "#4caf50" // verde
                            : tempoRestante > 10
                            ? "#ff9800" // laranja
                            : "#f44336", // vermelho
                        transition: "width 1s linear",
                      }}
                    />
                  </span>
                  <span className="tempo-texto destaque-tempo">Tempo restante: {tempoRestante}s</span>
                </div>
              </div>

              {/* Rodapé da sidebar com botões FAQ e Sair arredondados */}
              <div className="sidebar-footer">
                <button onClick={() => setFaqAberto(true)} className="btn-faq" title="FAQ / Como jogar">
                  FAQ
                </button>
                <button onClick={sair} className="btn-sair" title="Sair da sala">
                  Sair
                </button>
              </div>
            </aside>
          </div>
        </>
      )}

      {jogoFinalizado && (
        <div className="fim-jogo-overlay" role="dialog" aria-modal="true" aria-labelledby="fim-jogo-titulo">
          <h2 id="fim-jogo-titulo">Fim de jogo!</h2>
          <button
            onClick={() => {
              setJogoFinalizado(false);
              setCategoria("");
              setAcertadas([]);
              setRodada(1);
              setUsuarios({});
              setMensagens([]);
              setEmJogo(false);
              setTempoRespostaJogadores({});
            }}
            className="btn-login"
          >
            Voltar para o início
          </button>
        </div>
      )}

      {faqAberto && (
        <div className="faq-modal" role="dialog" aria-modal="true" aria-labelledby="faq-titulo">
          <div className="faq-conteudo">
            <h2 id="faq-titulo">Como jogar Thoth</h2>
            <p>Em cada rodada, uma categoria será exibida. Você deve tentar adivinhar as palavras relacionadas à categoria enviando chutes no chat.</p>
            <p>Você tem 90 segundos para cada rodada. O primeiro a acertar uma palavra recebe pontos extras!</p>
            <p>Se seu chute estiver perto (erro pequeno), receberá uma dica especial.</p>
            <p>Você pode sair da sala a qualquer momento com o botão "Sair da sala".</p>
            <button onClick={() => setFaqAberto(false)} className="btn-faq-close">
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
