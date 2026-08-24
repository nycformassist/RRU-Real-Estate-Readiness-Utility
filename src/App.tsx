try {
      const response = await fetchWithEvaluateRetry("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase:       currentPhase,
          question:    currentQuestion.question,
          answer:      text.trim(),
          allAnswers:  answers,
        }),
      });

      if (!response.ok) throw new Error(`Evaluation API returned ${response.status}`);

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      // Add the AI's response to the chat
      addMessage(
        "model",
        data.agentResponse || "Your response does not meet the minimum requirements. Please clarify."
      );

      let dataWasValid = false;

      // Extract and save the data if valid
      if ((data.isValid === true || data.isValid === "true") && data.extractedData) {
        dataWasValid = true;
        setAnswers((prev) => ({
          ...prev,
          [currentQuestion.field]: String(data.extractedData).trim(),
        }));
      }

      // THE FIX: Bulletproof advancement logic
      const shouldAdvance = 
        data.advancePhase === true || 
        data.advancePhase === "true" || 
        dataWasValid || 
        Boolean(data.extractedData);

      if (shouldAdvance) {
        const nextPhase = currentPhase + 1;

        if (nextPhase <= INTAKE_QUESTIONS.length) {
          setCurrentPhase(nextPhase);
        } else {
          setCurrentPhase(INTAKE_QUESTIONS.length + 1);
          setTimeout(() => {
            addMessage(
              "system",
              "All 10 phases of the buyer qualification interview are complete. Please review your answers below. You may edit any field before submitting. When ready, click **Submit Profile** to send your information to our real estate team."
            );
          }, 350);
        }
      }