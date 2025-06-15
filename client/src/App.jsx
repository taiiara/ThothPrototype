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
  const [rankingVitorias, setRankingVitorias] = useState([]);
  const [top3, setTop3] = useState([]);

  const chatRef = useRef(null);
  const timerInterval = useRef(null);
  const delayCategoriaTimeout = useRef(null);

  function tocarSom(audio) {
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }

  useEffect(() => {
    const ultimaMsg = mensagens[mensagens.length - 1];
    if (ultimaMsg?.nome === "Sistema" && ultimaMsg.texto.includes("Rodada") && ultimaMsg.texto.includes("iniciada")) {
      setTempoRestante(90);
    }
  }, [mensagens]);

  useEffect(() => {
    socket.on("connect", () => {});

    socket.on("dadosSala", (dados) => {
      setLimiteSala(dados.limiteSala || null);
      setCategoria(dados.categoria);
      setAcertadas(dados.acertadas || []);
      setRodada(dados.rodada || 1);
      setEmJogo(true);
      setTempoRespostaJogadores({});
      tocarSom(somNovaRodada);
    });

    socket.on("atualizarAcertadas", (listaAtualizada) => {
      setAcertadas(listaAtualizada);
    });

    socket.on("usuariosAtualizados", (atualizados) => {
      // atualiza também as vitórias no usuário, se ranking estiver setado
      const sorted = Object.entries(atualizados)
        .map(([id, u]) => {
          // procura vitórias no ranking pelo nome do usuário
          const rankingEntry = rankingVitorias.find((r) => r.nome === u.nome);
          return {
            ...u,
            vitorias: rankingEntry ? rankingEntry.vitorias : 0,
          };
        })
        .sort((a, b) => b.pontos - a.pontos)
        .reduce((acc, u) => {
          acc[u.nome] = u;
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

        // Aqui adiciona a palavra ao array acertadas, mantendo maiúsculas/minúsculas
        setAcertadas((prev) => {
          if (prev.includes(msg.texto)) return prev; // evita duplicatas
          return [...prev, msg.texto];
        });
      } else if (msg.perto && msg.destinatario === nome) {
        novaMsg.texto = `"${msg.texto}" do usuário ${msg.nome} está perto`;
        tocarSom(somErroProximo);
      }

      setMensagens((msgs) => [...msgs, novaMsg]);
    });

    // Novo evento para atualizar ranking de vitórias
    socket.on("atualizarRanking", (ranking) => {
      setRankingVitorias(ranking);

      // Atualiza usuários com as vitórias para exibir
      setUsuarios((prevUsuarios) => {
        const atualizados = { ...prevUsuarios };
        ranking.forEach(({ nome, vitorias }) => {
          // Atualiza só se usuário existir
          for (const id in atualizados) {
            if (atualizados[id].nome === nome) {
              atualizados[id].vitorias = vitorias;
            }
          }
        });
        return atualizados;
      });
    });

    socket.on("estadoJogo", ({ emJogo }) => {
      setEmJogo(emJogo);
    });

    socket.on("fimDeJogo", ({ mensagem, ranking }) => {
      setJogoFinalizado(true);
      setEmJogo(false);
      setTop3(ranking); // <-- aqui está o pulo do gato
      tocarSom(somFimJogo);

      setAcertadas([]); // limpa as palavras acertadas

      setUsuarios((prevUsuarios) => {
        const zerados = {};
        for (const id in prevUsuarios) {
          zerados[id] = {
            ...prevUsuarios[id],
            pontos: 0, // zera pontos
          };
        }
        return zerados;
      });
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
      socket.off("connect");
      socket.off("dadosSala");
      socket.off("atualizarAcertadas");
      socket.off("usuariosAtualizados");
      socket.off("mensagem");
      socket.off("atualizarRanking");
      socket.off("fimDeJogo");
      socket.off("fimJogo");
      socket.off("salaCheia");
      socket.off("disconnect");
      socket.off("removidoInatividade");
      socket.off("estadoJogo");
      clearInterval(timerInterval.current);
      clearTimeout(delayCategoriaTimeout.current);
    };
  }, [nome, rankingVitorias]);

  useEffect(() => {
    if (!emJogo) {
      clearInterval(timerInterval.current);
      setTempoRestante(0);
      return;
    }

    const intervaloVerificacao = setInterval(() => {
      const ultimaMensagem = mensagens[mensagens.length - 1];

      if (ultimaMensagem?.nome === "Sistema" && /(\d+)\s*segundos/i.test(ultimaMensagem.texto)) {
        const match = ultimaMensagem.texto.match(/(\d+)\s*segundos/i);
        if (match) {
          const segundos = parseInt(match[1], 10);

          setTempoRestante(segundos);

          clearInterval(timerInterval.current);
          clearInterval(intervaloVerificacao); // para o polling

          timerInterval.current = setInterval(() => {
            setTempoRestante((tempo) => {
              if (tempo <= 1) {
                clearInterval(timerInterval.current);
                return 0;
              }
              return tempo - 1;
            });
          }, 1000);
        }
      } else {
        console.log("Última mensagem não contém segundos, aguardando...");
      }
    }, 300);

    return () => {
      clearInterval(intervaloVerificacao);
    };
  }, [mensagens, emJogo]);

  useEffect(() => {
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

  function capitalizarTitulo(str) {
    return str
      .split(" ")
      .map((palavra) => palavra.charAt(0).toUpperCase() + palavra.slice(1).toLowerCase())
      .join(" ");
  }

  return (
    <div className="app-container">
      {!categoria && !jogoFinalizado && (
        <div className="login">
          <form
            onSubmit={(e) => {
              e.preventDefault(); // impede reload
              entrar(); // executa a função de entrada
            }}
          >
            <input value={nome} onChange={(e) => setNome(e.target.value)} maxLength={15} placeholder="Seu nome" className="input-login" />
            <input value={sala} onChange={(e) => setSala(e.target.value)} maxLength={15} placeholder="Sala" className="input-login" />
            <button type="submit" className="btn-login" disabled={limiteSala && Object.keys(usuarios).length >= limiteSala}>
              Entrar
            </button>
          </form>
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
                {Object.entries(usuarios)
                  .sort(([, a], [, b]) => b.pontos - a.pontos)
                  .map(([id, u]) => (
                    <li key={id} className={u.bonusPrimeiro ? "destaque-primeiro" : ""} title={`Tempo para acertar: ${tempoRespostaJogadores[u.nome] != null ? tempoRespostaJogadores[u.nome] + "s" : "N/A"}`}>
                      {u.nome}: {u.pontos} pts {u.bonusPrimeiro && <span className="badge">1º!</span>}
                      {tempoRespostaJogadores[u.nome] != null && <small> ({tempoRespostaJogadores[u.nome]}s)</small>}
                    </li>
                  ))}
              </ul>

              <h3>Palavras Descobertas</h3>
              <ul className="palavras-acertadas">{acertadas.length === 0 ? <p className="text-sm text-gray-500 italic">Nenhuma palavra descoberta ainda</p> : acertadas.map((p, i) => <li key={i}>{capitalizarTitulo(p)}</li>)}</ul>
            </aside>

            <section className="chat-section">
              <div ref={chatRef} className="chat-messages" aria-live="polite" aria-atomic="false">
                {mensagens.map((msg, i) => (
                  <div key={i} className={`chat-msg ${msg.nome === "Sistema" ? "chat-sistema" : ""} ${msg.acertou ? "chat-acerto" : ""} ${msg.perto ? "chat-perto" : ""}`}>
                    <strong>{msg.nome}:</strong> {msg.texto} {msg.acertou}
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

              <div className="ranking-vitorias mt-4">
                <h3 className="text-lg font-semibold mb-2">Ranking de Vitórias</h3>
                {rankingVitorias.length > 0 ? (
                  <ul className="space-y-1">
                    {rankingVitorias
                      .slice()
                      .sort((a, b) => b.vitorias - a.vitorias)
                      .map((jogador, i) => (
                        <li key={jogador.id}>
                          {i + 1}º {jogador.nome} — {jogador.vitorias} vitória{jogador.vitorias !== 1 ? "s" : ""}
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500">Aguardando fim da partida</p>
                )}
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
        <div className="fim-jogo-overlay" role="dialog" aria-modal="true" aria-labelledby="fim-jogo-titulo" tabIndex={-1}>
          <div className="fim-jogo-modal">
            <h2 id="fim-jogo-titulo">Fim da Rodada!</h2>

            {Array.isArray(top3) && top3.length > 0 && top3.some((j) => j.nome) ? (
              <div className="podio">
                {[1, 0, 2].map((posicao, i) => {
                  const jogador = top3[posicao];
                  if (!jogador) return null;
                  return (
                    <div key={jogador.id || i} className={`podio-posicao pos-${posicao + 1}`}>
                      <div className="podio-trofeu">{posicao + 1}º</div>
                      <div className="podio-nome">{jogador.nome}</div>
                      <div className="podio-pontos">
                        {jogador.pontos} ponto{jogador.pontos === 1 ? "" : "s"}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p>Sem dados dos vencedores.</p>
            )}

            <button onClick={() => setJogoFinalizado(false)} className="btn-login" autoFocus>
              Continuar
            </button>
          </div>
        </div>
      )}

      {faqAberto && (
        <div className="faq-modal" role="dialog" aria-modal="true" aria-labelledby="faq-titulo">
          <div className="faq-conteudo">
            <h2 id="faq-titulo">Como jogar Thoth</h2>

            <p>
              <strong>1. Objetivo:</strong> Adivinhar palavras relacionadas à categoria exibida em cada rodada.
            </p>

            <p>
              <strong>2. Tempo:</strong> Cada rodada dura <strong>90 segundos</strong>.
            </p>

            <p>
              <strong>3. Como jogar:</strong> Envie suas respostas no chat. O primeiro jogador a acertar cada palavra ganha <strong> um ponto extra</strong>!
            </p>

            <p>
              <strong>4. Dicas:</strong> Se seu chute estiver próximo da resposta correta, você receberá um <strong>aviso</strong> para te ajudar.
            </p>

            <p>
              <strong>5. Sair da sala:</strong> Use o botão <em>"Sair da sala"</em> a qualquer momento, caso deseje sair do jogo.
            </p>

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
